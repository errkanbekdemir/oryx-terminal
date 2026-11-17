#!/usr/bin/env python3
"""
Test for ORYX RX timestamps (stamped when bytes are read from the port, each
line dated by its first byte). Checks the timestamps ORYX writes to its log.

Two modes — in both, ORYX must be in Text view with Logging ON:

1) Simulated (no device). The script poses as a share and sends numbered
   lines with exact read times, delivered with deliberate network jitter.
   Lines must come out evenly spaced anyway.

       python3 scripts/timestamp_test.py --sim
       ORYX: REMOTE tab, address 127.0.0.1:48551, token ABCD-EFGH-JKLM-NPQR

2) Real port with a hardware loopback (TX shorted to RX). ORYX shares the
   port; the script sends bursts through it and the looped-back lines are
   stamped by ORYX's serial reader. Lines in a burst must be spaced by their
   time on the wire instead of sharing one timestamp.

       python3 scripts/timestamp_test.py <ip> <TOKEN>

The log is read from ~/Documents/ORYX_Logs on this machine (--log auto, the
default); if ORYX runs elsewhere, copy its log here and pass --log <file>,
or drag it in when asked.

    pip install websockets cryptography
"""
import argparse
import asyncio
import glob
import json
import os
import re
import statistics
import struct
import sys
import time

from bridge_stress import M_DATA, M_INFO, M_PING, M_PONG, connect, handshake, normalize_address, normalize_token

M_TIME = 0x07
LOG_RX = re.compile(r"^\[(\d\d):(\d\d):(\d\d)\.(\d{3})\] RX  (T[SD]) (\d+) (\d+) ")

# Simulated: 2 groups of 40 lines, 50 bytes each at 0.5 ms/byte -> 25 ms per line
SIM_LINE, SIM_BYTE_MS, SIM_LINES, SIM_GROUP_GAP_MS, SIM_CHUNK = 50, 0.5, 40, 3000, 137
SIM_JITTER_MS = [0, 60, 10, 80, 0, 45, 25, 70]
# Device: 4 bursts of 30 lines, 40 bytes each
DEV_LINE, DEV_LINES, DEV_BURSTS, DEV_PAUSE_S = 40, 30, 4, 0.8


def line(tag: str, group: int, n: int, size: int) -> bytes:
    head = f"{tag} {group} {n:03d} ".encode()
    filler = (b"abcdefghijklmnopqrstuvwxyz" * (size // 26 + 1))[: size - len(head) - 2]
    return head + filler + b"\r\n"


def read_log(path: str, tag: str) -> dict[int, list[tuple[int, float]]]:
    """group -> [(line number, ms since midnight)] in log order"""
    groups: dict[int, list[tuple[int, float]]] = {}
    with open(path, encoding="utf-8", errors="replace") as f:
        for ln in f:
            m = LOG_RX.match(ln)
            if m and m[5] == tag:
                ms = ((int(m[1]) * 60 + int(m[2])) * 60 + int(m[3])) * 1000 + int(m[4])
                groups.setdefault(int(m[6]), []).append((int(m[7]), ms))
    return groups


def find_log(arg: str, since: float) -> str | None:
    if arg != "auto":
        return os.path.expanduser(arg.strip().strip("'\""))
    files = sorted(glob.glob(os.path.expanduser("~/Documents/ORYX_Logs/session_log_*.txt")), key=os.path.getmtime)
    return files[-1] if files and os.path.getmtime(files[-1]) >= since else None


def check(groups, n_groups: int, n_lines: int, line_ms: float, tol_ms: float, gaps_ms: list[float], gap_tol_ms: float) -> bool:
    ok = True

    def result(passed: bool, text: str):
        nonlocal ok
        ok = ok and passed
        print(f"  {'PASS' if passed else 'FAIL'}  {text}")

    firsts = []
    for g in range(1, n_groups + 1):
        rows = groups.get(g, [])
        if [n for n, _ in rows] != list(range(1, n_lines + 1)):
            have = [n for n, _ in rows]
            missing = sorted(set(range(1, n_lines + 1)) - set(have))
            result(False, f"group {g}: expected lines 1..{n_lines} in order, got {len(rows)} line(s)"
                   + (f" — missing {missing} (data lost before it reached ORYX's reader)" if missing else " — out of order or repeated"))
            continue
        times = [t for _, t in rows]
        firsts.append(times[0])
        steps = [b - a for a, b in zip(times, times[1:])]
        result(all(s >= 0 for s in steps), f"group {g}: timestamps never go backwards")
        med = statistics.median(steps)
        result(abs(med - line_ms) <= tol_ms,
               f"group {g}: median spacing {med:.1f} ms (expected {line_ms:.1f} ±{tol_ms:.1f})")
        span, want = times[-1] - times[0], line_ms * (n_lines - 1)
        # Can't be shorter than the time on the wire; it is longer when the
        # sender paused inside the burst (ORYX writes large blocks in slices).
        result(span >= want - max(0.25 * want, 20),
               f"group {g}: first-to-last {span:.0f} ms (at least ~{want:.0f} on the wire"
               + (f"; sent {span / want:.1f}x slower than line rate)" if span > 1.4 * want else ")"))
        if line_ms >= 1.5:
            distinct = len(set(times))
            result(distinct >= 0.7 * n_lines,
                   f"group {g}: {distinct}/{n_lines} distinct timestamps (old behaviour: a few per group)")
    for i, want in enumerate(gaps_ms):
        if i + 1 < len(firsts):
            got = firsts[i + 1] - firsts[i]
            result(abs(got - want) <= gap_tol_ms, f"group {i + 1} -> {i + 2}: {got:.0f} ms apart (expected {want:.0f} ±{gap_tol_ms:.0f})")
    return ok


async def get_log(arg: str, started: float) -> str | None:
    await asyncio.sleep(1.5)  # let ORYX close and write the last lines
    path = find_log(arg, started)
    if path and os.path.exists(path):
        return path
    print("\nNo ORYX log from this run found on this machine (is Logging on?).")
    answer = (await asyncio.to_thread(input, "Drag the ORYX log file here, or Enter to give up: ")).strip()
    return find_log(answer, 0) if answer else None


async def run_sim(args) -> int:
    from selection_test import PORT, TOKEN
    from selection_test import handshake as server_handshake
    try:
        from websockets.asyncio.server import serve
    except ImportError:
        from websockets import serve

    done: asyncio.Future = asyncio.get_running_loop().create_future()

    async def handler(ws):
        ch = await server_handshake(ws)
        if ch is None:
            return
        lock = asyncio.Lock()

        async def send(kind, payload=b""):
            async with lock:
                await ws.send(ch.seal(kind, payload))

        info = {"host": "timestamp-test", "port_name": "TEST", "baud": 20000, "serial_connected": True}
        await send(M_INFO, json.dumps(info).encode())
        await asyncio.sleep(1.0)
        started = time.time()
        t0 = time.time() * 1000 + 200
        chunk_no = 0
        for group in (1, 2):
            data = b"".join(line("TS", group, n, SIM_LINE) for n in range(1, SIM_LINES + 1))
            base = t0 + (group - 1) * SIM_GROUP_GAP_MS
            for off in range(0, len(data), SIM_CHUNK):
                chunk = data[off:off + SIM_CHUNK]
                # "Read time" of the chunk's last byte at a steady line rate...
                ts = base + (off + len(chunk)) * SIM_BYTE_MS
                # ...delivered late by a varying amount, like a jittery network
                jitter = SIM_JITTER_MS[chunk_no % len(SIM_JITTER_MS)]
                chunk_no += 1
                await asyncio.sleep(max(0.0, (ts + jitter) / 1000 - time.time()))
                await send(M_TIME, struct.pack("<dd", ts, SIM_BYTE_MS))
                await send(M_DATA, chunk)
        if not done.done():
            done.set_result(started)
        async for frame in ws:
            kind, _ = ch.open(frame)
            if kind == M_PING:
                await send(M_PONG)

    async with serve(handler, "127.0.0.1", PORT, max_size=None, ping_interval=None):
        print(f"Start Logging in ORYX (Text view), then connect: REMOTE tab, 127.0.0.1:{PORT}, token {TOKEN}")
        started = await done
        print("Sent 2 groups of 40 lines with up to 80 ms of delivery jitter.")
        path = await get_log(args.log, started)
    if not path:
        return 1
    print(f"\nChecking {path}")
    ok = check(read_log(path, "TS"), 2, SIM_LINES, SIM_LINE * SIM_BYTE_MS, 1.5, [SIM_GROUP_GAP_MS], 5)
    print("\nPASS — lines are dated by read time, not delivery time" if ok else "\nFAIL")
    return 0 if ok else 1


def wire_groups(chunks: list[tuple[float, float, bytes]]) -> dict[int, list[tuple[int, float]]]:
    """Date each looped-back line by its first byte from the share's M_TIME
    frames — the same arithmetic ORYX's UI does (arrivalOf in App.tsx)."""
    marks, stream, total = [], b"", 0
    for ts, byte_ms, data in chunks:
        total += len(data)
        stream += data
        marks.append((total, ts, byte_ms))
    # Earliest bound over this and all later reads (see arrivalOf in App.tsx)
    bound, low = [0.0] * len(marks), float("inf")
    for j in range(len(marks) - 1, -1, -1):
        end, ts, byte_ms = marks[j]
        low = min(low, ts - (end - 1) * byte_ms)
        bound[j] = low
    groups: dict[int, list[tuple[int, float]]] = {}
    pos = mark = 0
    last = 0.0
    for ln in stream.split(b"\r\n")[:-1]:
        while mark < len(marks) and marks[mark][0] <= pos:
            mark += 1
        if mark < len(marks):
            _, ts, byte_ms = marks[mark]
            last = max(last, min(ts, bound[mark] + pos * byte_ms) if byte_ms > 0 else ts)
            m = re.match(rb"TD (\d+) (\d+) ", ln)
            if m:
                groups.setdefault(int(m[1]), []).append((int(m[2]), last))
        pos += len(ln) + 2
    return groups


async def run_device(args) -> int:
    address = normalize_address(args.address)
    print(f"Connecting to ws://{address} ...")
    sent_at: list[float] = []
    chunks: list[tuple[float, float, bytes]] = []
    untimed = 0
    async with connect(f"ws://{address}", max_size=None, ping_interval=None) as ws:
        ch, info = await handshake(ws, normalize_token(args.token))
        print(f"Connected: {info['port_name']} @ {info['baud']} baud on {info['host']}")
        lock = asyncio.Lock()

        async def send(kind, payload=b""):
            async with lock:
                await ws.send(ch.seal(kind, payload))

        async def drain():
            nonlocal untimed
            pending = None
            while True:
                kind, data = ch.open(await ws.recv())
                if kind == M_PING:
                    await send(M_PONG)
                elif kind == M_TIME and len(data) == 16:
                    pending = struct.unpack("<dd", data)
                elif kind == M_DATA:
                    if pending:
                        chunks.append((pending[0], pending[1], data))
                    else:
                        untimed += 1
                    pending = None

        drainer = asyncio.create_task(drain())
        started = time.time()
        byte_ms = 10_000 / info["baud"]  # 8N1
        # Long enough lines that one takes >= 4 ms on the wire: timestamps
        # have 1 ms resolution, so shorter lines could "pass" while sharing one.
        size = min(max(DEV_LINE, int(4 / byte_ms) + 1), 600)
        line_ms = size * byte_ms
        burst_s = DEV_LINES * line_ms / 1000
        try:
            for b in range(1, DEV_BURSTS + 1):
                sent_at.append(time.time() * 1000)
                await send(M_DATA, b"".join(line("TD", b, n, size) for n in range(1, DEV_LINES + 1)))
                await asyncio.sleep(burst_s + DEV_PAUSE_S)
        finally:
            drainer.cancel()
        print(f"Sent {DEV_BURSTS} bursts of {DEV_LINES} lines ({size} bytes each, {line_ms:.2f} ms on the wire per line).")
        gaps = [b - a for a, b in zip(sent_at, sent_at[1:])]
        tol = max(1.0, 0.2 * line_ms)

        print("\n1) Read times sent by the sharing ORYX (its serial reader, before any UI):")
        if not chunks:
            print("  FAIL  no read times received — the sharing ORYX is an older build without this\n"
                  "        feature. Install the latest build on that machine and run again.")
            wire_ok = False
        else:
            sizes = sorted(len(d) for _, _, d in chunks)
            print(f"  ({len(chunks)} reads, {sizes[0]}-{sizes[-1]} bytes each, {chunks[0][1]:.3f} ms/byte"
                  + (f", {untimed} without a time" if untimed else "") + ")")
            # Burst-to-burst spacing is compared with when this script sent them, which
            # includes network delivery jitter — hence the loose tolerance here.
            wire_ok = check(wire_groups(chunks), DEV_BURSTS, DEV_LINES, line_ms, tol, gaps, 250)

        print("\n2) Timestamps in the sharing ORYX's log (what its screen shows):")
        path = await get_log(args.log, started)
    if not path:
        print("  (skipped — no log)")
        return 0 if wire_ok else 1
    print(f"  {path}")
    log_ok = check(read_log(path, "TD"), DEV_BURSTS, DEV_LINES, line_ms, tol, gaps, 250)
    ok = wire_ok and log_ok
    print("\nPASS — lines are dated by when they arrived at the port" if ok else "\nFAIL")
    return 0 if ok else 1


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("address", nargs="?", help="share address (device mode)")
    p.add_argument("token", nargs="?", help="share token (device mode)")
    p.add_argument("--sim", action="store_true", help="simulated mode: the script is the share, no device needed")
    p.add_argument("--log", default="auto", help="ORYX log file to check (default: newest in ~/Documents/ORYX_Logs)")
    args = p.parse_args()
    if not args.sim and not (args.address and args.token):
        p.error("give <ip> <TOKEN> for device mode, or --sim")
    sys.exit(asyncio.run(run_sim(args) if args.sim else run_device(args)))


if __name__ == "__main__":
    main()
