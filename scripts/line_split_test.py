#!/usr/bin/env python3
"""
Line-assembly test for ORYX, over a real serial port with a hardware
loopback (TX shorted to RX).

ORYX shares the looped-back port; this script connects to the share and
sends lines with deliberate pauses in the middle (mid-line stalls, a CRLF
split across two writes, a prompt with no EOL). The bytes come back through
the loopback as RX, and ORYX must show each one as a single, unbroken line.

    pip install websockets cryptography
    python3 scripts/line_split_test.py <ip> <TOKEN>                 # watch the ORYX screen
    python3 scripts/line_split_test.py <ip> <TOKEN> --log auto      # also auto-check the log

For the automatic check, start Logging in ORYX (view mode Text) before
running; `--log auto` picks the newest file in ~/Documents/ORYX_Logs, or
pass the log file path. Disconnect any other client from the share first.
"""
import argparse
import asyncio
import glob
import os
import sys
import time

from bridge_stress import M_DATA, M_PING, M_PONG, connect, handshake, normalize_address, normalize_token

# (name, parts, expected RX lines). A number in `parts` is a pause in ms.
CASES = [
    ("pause mid-line", [b"[ ", 300, b"12.345] boot ok\r\n"], [b"[ 12.345] boot ok\r\n"]),
    ("CRLF split across writes", [b"abc\r", 300, b"\nnext\r\n"], [b"abc\r\n", b"next\r\n"]),
    ("prompt, answer 1 s later", [b"> ", 1000, b"ok\r\n"], [b"> ok\r\n"]),
    ("several short pauses", [b"a", 150, b"b", 150, b"c", 150, b"\r\n"], [b"abc\r\n"]),
    ("pause right before EOL", [b"value=42", 400, b"\r\n"], [b"value=42\r\n"]),
    ("burst of 50 lines", [b"".join(b"BURST %02d quick brown fox\r\n" % i for i in range(50))],
     [b"BURST %02d quick brown fox\r\n" % i for i in range(50)]),
]


def marker(i: int, name: str) -> bytes:
    return f"=== CASE {i}: {name} ===\r\n".encode()


def escape(line: bytes) -> str:
    """How ORYX writes an RX line in Text view mode to its log file."""
    out = []
    for b in line:
        out.append({0x0D: "\\r", 0x0A: "\\n", 0x09: "\\t"}.get(b) or (chr(b) if 0x20 <= b <= 0x7E else "."))
    return "".join(out)


def check_log(path: str) -> bool:
    with open(path, encoding="utf-8", errors="replace") as f:
        rx = [ln.split(" RX  ", 1)[1].rstrip("\n") for ln in f if " RX  " in ln]
    ok_all = True
    for i, (name, _, expected) in enumerate(CASES, 1):
        try:
            start = len(rx) - 1 - rx[::-1].index(escape(marker(i, name)))  # last run wins
        except ValueError:
            print(f"  ? case {i} ({name}): marker not found in log")
            ok_all = False
            continue
        got = rx[start + 1:start + 1 + len(expected)]
        want = [escape(e) for e in expected]
        if got == want:
            print(f"  PASS case {i}: {name}")
        else:
            ok_all = False
            print(f"  FAIL case {i}: {name}")
            for w, g in zip(want, got + [""] * len(want)):
                if w != g:
                    print(f"      expected: {w}\n      got:      {g or '(missing)'}")
                    break
    return ok_all


def find_log(arg: str, since: float):
    if arg != "auto":
        return arg
    files = sorted(glob.glob(os.path.expanduser("~/Documents/ORYX_Logs/session_log_*.txt")), key=os.path.getmtime)
    return files[-1] if files and os.path.getmtime(files[-1]) >= since else None


async def run(args):
    started = time.time()
    address = normalize_address(args.address)
    print(f"Connecting to ws://{address} ...")
    async with connect(f"ws://{address}", max_size=None, ping_interval=None) as ws:
        ch, info = await handshake(ws, normalize_token(args.token))
        print(f"Connected: {info['port_name']} @ {info['baud']} baud on {info['host']}\n")
        lock = asyncio.Lock()

        async def send(kind, payload=b""):
            async with lock:  # keeps the seal counter in send order
                await ws.send(ch.seal(kind, payload))

        async def drain():  # loopback echo + keepalive; the check happens in ORYX
            while True:
                kind, _ = ch.open(await ws.recv())
                if kind == M_PING:
                    await send(M_PONG)

        drainer = asyncio.create_task(drain())
        try:
            for i, (name, parts, expected) in enumerate(CASES, 1):
                await send(M_DATA, marker(i, name))
                await asyncio.sleep(0.3)
                for p in parts:
                    if isinstance(p, int):
                        await asyncio.sleep(p / 1000)
                    else:
                        await send(M_DATA, p)
                shown = expected if len(expected) <= 3 else expected[:2] + [b"...", expected[-1]]
                print(f"CASE {i}: {name}")
                for e in shown:
                    print(f"    expect: {escape(e)}")
                await asyncio.sleep(0.5)
            await asyncio.sleep(1.5)  # let ORYX close and log the last lines
        finally:
            drainer.cancel()

    print("\nOn the ORYX screen each 'expect' above must be exactly one RX line —")
    print("no line split where a pause was, no extra empty line after 'abc'.")
    if args.log:
        path = find_log(args.log, started)
        if not path:
            print("\nNo ORYX log written during this run — is Logging on?")
            return 1
        print(f"\nChecking {path}")
        return 0 if check_log(path) else 1
    return 0


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("address", help="share address, host or host:port")
    p.add_argument("token", help="share token, e.g. ABCD-EFGH-JKLM-NPQR")
    p.add_argument("--log", help="ORYX log file to verify, or 'auto' for the newest in ~/Documents/ORYX_Logs")
    sys.exit(asyncio.run(run(p.parse_args())))


if __name__ == "__main__":
    main()
