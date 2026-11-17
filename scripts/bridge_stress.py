#!/usr/bin/env python3
"""
Large-transfer test for the ORYX network share, run against a share whose
serial port has a hardware loopback (TX shorted to RX).

Acts as the remote client: sends a large text payload through the share,
collects what comes back from the loopback, and compares it byte for byte.

    pip install websockets cryptography
    python3 scripts/bridge_stress.py 192.168.1.20 ABCD-EFGH-JKLM-NPQR --size 1M

The share allows one client at a time, so disconnect the other ORYX first.
Sending is paced to ~90% of the share's baud rate by default; use --no-pace
to push as fast as possible and see how the bridge copes.

Protocol reference: src-tauri/src/remote_bridge.rs (keep the two in sync).
"""
import argparse
import asyncio
import hashlib
import hmac
import json
import os
import re
import struct
import sys
import time

try:
    from websockets.asyncio.client import connect
except ImportError:  # websockets < 14
    from websockets import connect
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

PROTO_VERSION = 1
DEFAULT_PORT = 48550
F_HELLO, F_AUTH, F_AUTH_OK, F_AUTH_FAIL, F_BUSY, F_SEALED = 0x01, 0x02, 0x03, 0x04, 0x05, 0x10
M_DATA, M_INFO, M_STATUS, M_PING, M_PONG, M_TX = 0x01, 0x02, 0x03, 0x04, 0x05, 0x06


def hkdf(token: bytes, salt: bytes, info: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=info).derive(token)


class Channel:
    """Per-direction ChaCha20-Poly1305 with an implicit 64-bit counter nonce."""

    def __init__(self, seal_key: bytes, open_key: bytes):
        self.seal_aead, self.open_aead = ChaCha20Poly1305(seal_key), ChaCha20Poly1305(open_key)
        self.seal_ctr = self.open_ctr = 0

    @staticmethod
    def _nonce(ctr: int) -> bytes:
        return b"\x00" * 4 + struct.pack("<Q", ctr)

    def seal(self, kind: int, payload: bytes = b"") -> bytes:
        ct = self.seal_aead.encrypt(self._nonce(self.seal_ctr), bytes([kind]) + payload, None)
        self.seal_ctr += 1
        return bytes([F_SEALED]) + ct

    def open(self, frame: bytes):
        if not frame or frame[0] != F_SEALED:
            raise ValueError("unexpected cleartext frame")
        pt = self.open_aead.decrypt(self._nonce(self.open_ctr), frame[1:], None)
        self.open_ctr += 1
        return pt[0], pt[1:]


def normalize_token(t: str) -> str:
    return "".join(c for c in t if c.isalnum()).upper()


def normalize_address(a: str) -> str:
    a = a.strip().removeprefix("ws://").rstrip("/")
    return a if re.search(r":\d+$", a) else f"{a}:{DEFAULT_PORT}"


def parse_size(s: str) -> int:
    m = re.fullmatch(r"(\d+)([KkMm]?)", s)
    if not m:
        raise argparse.ArgumentTypeError("size like 200K or 1M")
    return int(m[1]) * {"": 1, "k": 1024, "m": 1024 * 1024}[m[2].lower()]


def make_payload(size: int) -> bytes:
    """Numbered text lines, so gaps/reordering are obvious in the ORYX terminal too."""
    out, n = bytearray(), 0
    while len(out) < size:
        n += 1
        out += f"LINE {n:07d} THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG 0123456789\r\n".encode()
    return bytes(out[:size])


async def handshake(ws, token: str):
    hello = await ws.recv()
    if len(hello) != 34 or hello[0] != F_HELLO:
        sys.exit("Not an ORYX share")
    if hello[1] != PROTO_VERSION:
        sys.exit(f"Protocol version mismatch (remote v{hello[1]}, script v{PROTO_VERSION})")
    server_nonce, client_nonce = hello[2:34], os.urandom(32)
    salt = server_nonce + client_nonce
    auth = hkdf(token.encode(), salt, b"oryx/v1 auth")
    c2s = hkdf(token.encode(), salt, b"oryx/v1 c2s")
    s2c = hkdf(token.encode(), salt, b"oryx/v1 s2c")

    await ws.send(bytes([F_AUTH]) + client_nonce + hmac.new(auth, b"client", hashlib.sha256).digest())
    reply = await ws.recv()
    if reply[0] == F_AUTH_FAIL:
        sys.exit("Invalid token")
    if reply[0] == F_BUSY:
        sys.exit("Share is busy — disconnect the other client first")
    if reply[0] != F_AUTH_OK or not hmac.compare_digest(reply[1:], hmac.new(auth, b"server", hashlib.sha256).digest()):
        sys.exit("Server failed to prove the token")

    ch = Channel(c2s, s2c)
    kind, payload = ch.open(await ws.recv())
    if kind != M_INFO:
        sys.exit("Expected share info")
    return ch, json.loads(payload)


async def run(args):
    token = normalize_token(args.token)
    address = normalize_address(args.address)
    payload = make_payload(args.size)

    print(f"Connecting to ws://{address} ...")
    async with connect(f"ws://{address}", max_size=None, ping_interval=None) as ws:
        ch, info = await handshake(ws, token)
        print(f"Connected: {info['port_name']} @ {info['baud']} baud on {info['host']} (serial {'up' if info['serial_connected'] else 'DOWN'})")
        if not info["serial_connected"]:
            sys.exit("Shared serial port is down")

        rate = None if args.no_pace else max(1, int(info["baud"] / 10 * 0.9))
        expected_s = len(payload) / rate if rate else None
        print(f"Sending {len(payload):,} bytes in {args.chunk}-byte chunks"
              + (f", paced at {rate:,} B/s (~{expected_s:.0f}s)" if rate else ", unpaced"))

        received = bytearray()
        last_rx = time.monotonic()
        # Live gap detection on the numbered lines as they arrive
        lines = {"parsed_to": 0, "last": 0, "gaps": 0, "first_gap": None}

        def check_lines():
            while (nl := received.find(b"\n", lines["parsed_to"])) != -1:
                m = re.match(rb"LINE (\d{7}) ", received[lines["parsed_to"]:nl + 1])
                lines["parsed_to"] = nl + 1
                if not m:
                    lines["gaps"] += 1  # corrupted line
                    continue
                n = int(m[1])
                if n != lines["last"] + 1:
                    lines["gaps"] += 1
                    if lines["first_gap"] is None:
                        lines["first_gap"] = (lines["last"] + 1, n)
                lines["last"] = n

        def status_line():
            if not lines["gaps"]:
                gap = "  ✓ no gaps"
            elif lines["first_gap"]:
                exp, got = lines["first_gap"]
                gap = f"  ⚠ {lines['gaps']} GAP(S) — first: expected LINE {exp:07d}, got {got:07d}"
            else:
                gap = f"  ⚠ {lines['gaps']} corrupted line(s)"
            pct = len(received) * 100 / len(payload)
            return f"  {len(received):>10,} / {len(payload):,} bytes ({pct:5.1f}%) | last LINE {lines['last']:07d} of {total_lines:07d}{gap}"

        total_lines = payload.count(b"\n")
        done_sending = asyncio.Event()
        lock = asyncio.Lock()  # one writer at a time keeps the seal counter in send order

        async def send(frame):
            async with lock:
                await ws.send(frame)

        async def sender():
            start = time.monotonic()
            skip_at = (len(payload) // 2) // args.chunk * args.chunk if args.simulate_loss else -1
            for off in range(0, len(payload), args.chunk):
                if off == skip_at:
                    continue  # deliberate loss to prove the gap detector works
                await send(ch.seal(M_DATA, payload[off:off + args.chunk]))
                if rate:
                    ahead = (off + args.chunk) / rate - (time.monotonic() - start)
                    if ahead > 0:
                        await asyncio.sleep(ahead)
            done_sending.set()

        async def pinger():
            while True:
                await asyncio.sleep(5)
                await send(ch.seal(M_PING))

        async def receiver():
            nonlocal last_rx
            while len(received) < len(payload):
                try:
                    frame = await asyncio.wait_for(ws.recv(), timeout=1)
                except asyncio.TimeoutError:
                    if done_sending.is_set() and time.monotonic() - last_rx > args.idle:
                        return  # loopback went quiet — whatever is missing is lost
                    continue
                kind, data = ch.open(frame)
                if kind == M_DATA:
                    received.extend(data)
                    last_rx = time.monotonic()
                    check_lines()
                elif kind == M_PING:
                    await send(ch.seal(M_PONG))
                elif kind == M_STATUS:
                    print(f"\n  ! share reports serial {'up' if data[:1] == b'\x01' else 'DOWN'}")

        async def progress():
            while True:
                await asyncio.sleep(1)
                print("\r" + status_line(), end="", flush=True)

        t0 = time.monotonic()
        tasks = [asyncio.create_task(c()) for c in (sender, pinger, progress)]
        try:
            await receiver()
        finally:
            for t in tasks:
                t.cancel()
        elapsed = time.monotonic() - t0
        print("\r" + status_line())
        print(f"  {elapsed:.1f}s, {len(received) / elapsed / 1024:.1f} KB/s")

    if received == payload:
        print("PASS — loopback data matches byte for byte")
        return 0
    first = next((i for i, (a, b) in enumerate(zip(received, payload)) if a != b), min(len(received), len(payload)))
    line_start = payload.rfind(b"\n", 0, first) + 1
    print(f"FAIL — {len(payload) - len(received):,} bytes missing; first difference at byte {first:,}")
    print(f"  expected: {payload[line_start:line_start + 80]!r}")
    print(f"  got:      {bytes(received[line_start:line_start + 80])!r}")
    return 1


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("address", help="share address, host or host:port")
    p.add_argument("token", help="share token, e.g. ABCD-EFGH-JKLM-NPQR")
    p.add_argument("--size", type=parse_size, default=parse_size("200K"), help="payload size (default 200K)")
    p.add_argument("--chunk", type=int, default=512, help="bytes per DATA frame (default 512)")
    p.add_argument("--no-pace", action="store_true", help="send as fast as possible instead of at baud rate")
    p.add_argument("--idle", type=float, default=10, help="seconds of RX silence after sending before giving up")
    p.add_argument("--simulate-loss", action="store_true", help="skip one chunk mid-way to check that a loss is detected")
    sys.exit(asyncio.run(run(p.parse_args())))


if __name__ == "__main__":
    main()
