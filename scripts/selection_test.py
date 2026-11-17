#!/usr/bin/env python3
"""
Guided test for ORYX terminal selection + copy. No device needed.

The script poses as a network share: connect ORYX to it in REMOTE mode, it
streams 200 numbered rows, then walks you through selections. After each
copy it reads the clipboard and checks it against what should have been
copied.

    pip install websockets cryptography
    python3 scripts/selection_test.py

Then in ORYX: REMOTE tab, address 127.0.0.1:48551, the token printed below.
Use Text view. (macOS and Windows clipboards are supported.)
"""
import asyncio
import hashlib
import hmac
import json
import os
import re
import subprocess
import sys

try:
    from websockets.asyncio.server import serve
except ImportError:  # websockets < 14
    from websockets import serve

from bridge_stress import (F_AUTH, F_AUTH_FAIL, F_AUTH_OK, F_HELLO, M_DATA, M_INFO, M_PING, M_PONG,
                           PROTO_VERSION, Channel, hkdf, normalize_token)

PORT = 48551
TOKEN = "ABCD-EFGH-JKLM-NPQR"
ROWS = 200
SENTINEL = "ORYX-SELECTION-TEST-NOTHING-COPIED"
TS = re.compile(r"^\d\d:\d\d:\d\d\.\d{3} ")


def row(n: int) -> str:
    fox = {5: "the quick brown [A> fox jumps over the lazy dog",
           7: "the quick brown fox jumps <B] over the lazy dog",
           20: "the quick <D] brown fox jumps over the lazy dog",
           190: "the quick brown fox jumps over [C> the lazy dog"}.get(n, "the quick brown fox jumps over the lazy dog")
    return f"ROW {n:04d} {fox} {n:04d}"


def span(first: int, start_token: str, last: int, end_token: str) -> list[str]:
    """Rows first..last, cut to start at start_token and end after end_token."""
    lines = [row(n) for n in range(first, last + 1)]
    lines[0] = lines[0][lines[0].index(start_token):]
    lines[-1] = lines[-1][:lines[-1].index(end_token) + len(end_token)]
    return lines


def clipboard_get() -> str:
    cmd = ["pbpaste"] if sys.platform == "darwin" else ["powershell", "-NoProfile", "-Command", "Get-Clipboard -Raw"]
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8").stdout


def clipboard_set(text: str) -> None:
    cmd = ["pbcopy"] if sys.platform == "darwin" else ["clip"]
    subprocess.run(cmd, input=text, text=True, encoding="utf-8")


def norm(text: str) -> list[str]:
    return [ln.strip() for ln in text.splitlines() if ln.strip()]


def check(expected: list[str], timestamps: bool) -> bool:
    got_raw = clipboard_get()
    if got_raw.strip() == SENTINEL:
        print("    FAIL — nothing was copied (clipboard unchanged)")
        return False
    got = norm(got_raw)
    if timestamps:
        missing = [ln for ln in got if not TS.match(ln)]
        if missing:
            print(f"    FAIL — line without a timestamp: {missing[0]!r}")
            return False
        got = [TS.sub("", ln).strip() for ln in got]
    want = [ln.strip() for ln in expected]
    if got == want:
        print(f"    PASS — {len(got)} line(s) match exactly")
        return True
    print(f"    FAIL — expected {len(want)} line(s), got {len(got)}")
    for i in range(max(len(want), len(got))):
        w = want[i] if i < len(want) else "(nothing)"
        g = got[i] if i < len(got) else "(nothing)"
        if w != g:
            print(f"      first difference at line {i + 1}:\n        expected: {w!r}\n        got:      {g!r}")
            break
    return False


STEPS = [
    ("Text across rows",
     "Drag from just before  [A>  in ROW 0005 to just after  <B]  in ROW 0007, then press Cmd/Ctrl+C.",
     span(5, "[A>", 7, "<B]"), False),
    ("Same selection, with timestamps",
     "Make the same selection (ROW 0005 [A>  to  ROW 0007 <B]), right-click it →\n"
     "    'Copy Text Selection with Timestamps'.",
     span(5, "[A>", 7, "<B]"), True),
    ("Long selection that scrolls (upwards)",
     "Scroll to the bottom. Drag from just after  [C>  in ROW 0190 UP to just before  <D]  in ROW 0020:\n"
     "    hold the mouse at the top edge and let the list scroll. Then Cmd/Ctrl+C.",
     # dragging backwards: selection runs from <D] (start) to [C> (end)
     span(20, "<D]", 190, "[C>"), False),
    ("Whole lines from the timestamp column",
     "In the timestamp column, drag from ROW 0030 down to ROW 0034, then Cmd/Ctrl+C.",
     [row(n) for n in range(30, 35)], False),
    ("Single row (native selection)",
     "Inside ROW 0050 only, select the words  quick brown fox  and press Cmd/Ctrl+C.",
     ["quick brown fox"], False),
]


async def handshake(ws):
    token = normalize_token(TOKEN)
    server_nonce = os.urandom(32)
    await ws.send(bytes([F_HELLO, PROTO_VERSION]) + server_nonce)
    auth = await ws.recv()
    if len(auth) != 65 or auth[0] != F_AUTH:
        return None
    salt = server_nonce + auth[1:33]
    key = hkdf(token.encode(), salt, b"oryx/v1 auth")
    if not hmac.compare_digest(auth[33:], hmac.new(key, b"client", hashlib.sha256).digest()):
        await ws.send(bytes([F_AUTH_FAIL]))
        return None
    await ws.send(bytes([F_AUTH_OK]) + hmac.new(key, b"server", hashlib.sha256).digest())
    # server seals with s2c, opens with c2s
    return Channel(hkdf(token.encode(), salt, b"oryx/v1 s2c"), hkdf(token.encode(), salt, b"oryx/v1 c2s"))


async def main():
    connected: asyncio.Future = asyncio.get_running_loop().create_future()

    async def handler(ws):
        ch = await handshake(ws)
        if ch is None:
            print("  (a client failed the handshake — wrong token?)")
            return
        lock = asyncio.Lock()

        async def send(kind, payload=b""):
            async with lock:
                await ws.send(ch.seal(kind, payload))

        info = {"host": "selection-test", "port_name": "TEST", "baud": 115200, "serial_connected": True}
        await send(M_INFO, json.dumps(info).encode())
        for first in range(1, ROWS + 1, 20):
            await send(M_DATA, "".join(row(n) + "\r\n" for n in range(first, min(first + 20, ROWS + 1))).encode())
            await asyncio.sleep(0.05)
        if not connected.done():
            connected.set_result(True)
        async for frame in ws:  # keep the link alive while the user works
            kind, _ = ch.open(frame)
            if kind == M_PING:
                await send(M_PONG)

    async with serve(handler, "127.0.0.1", PORT, max_size=None, ping_interval=None):
        print(f"Waiting for ORYX — REMOTE tab, address 127.0.0.1:{PORT}, token {TOKEN}")
        await connected
        print(f"Connected, sent {ROWS} rows. Use Text view.\n")
        results = []
        try:
            for i, (name, how, expected, timestamps) in enumerate(STEPS, 1):
                print(f"STEP {i}/{len(STEPS)}: {name}\n    {how}")
                while True:
                    clipboard_set(SENTINEL)
                    answer = await asyncio.to_thread(input, "    Enter = check, s = skip: ")
                    if answer.strip().lower() == "s":
                        results.append((name, None))
                        break
                    ok = check(expected, timestamps)
                    if ok or (await asyncio.to_thread(input, "    Enter = try again, n = next step: ")).strip().lower() == "n":
                        results.append((name, ok))
                        break
                print()
        except EOFError:
            pass
        print("Summary:")
        for name, ok in results:
            print(f"  {'PASS' if ok else 'SKIP' if ok is None else 'FAIL'}  {name}")
        return 0 if results and all(ok for _, ok in results) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
