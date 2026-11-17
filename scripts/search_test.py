#!/usr/bin/env python3
"""
Guided test for the ORYX search results panel (Ctrl/Cmd+Shift+F): literal
and regex search, match case, RX/TX filter, copy results and save to file.
No device needed.

The script poses as a network share and streams 60 RX rows and 6 TX rows
with known contents. For each step you set up a search in ORYX and press the
panel's Copy button; the script reads the clipboard and compares it with the
exact lines that should have been found.

    pip install websockets cryptography
    python3 scripts/search_test.py

Then in ORYX: REMOTE tab, address 127.0.0.1:48551, the token printed below.
Use Text view.
"""
import asyncio
import json
import os
import re
import sys

try:
    from websockets.asyncio.server import serve
except ImportError:  # websockets < 14
    from websockets import serve

from bridge_stress import M_DATA, M_INFO, M_PING, M_PONG, M_TX
from selection_test import PORT, SENTINEL, TOKEN, clipboard_get, clipboard_set, handshake

RESULT = re.compile(r"^\d\d:\d\d:\d\d\.\d{3} (RX|TX|--)  (.*)$")


def rx(n: int) -> str:
    level = "err" if n == 15 else "ERR" if n % 10 == 0 else "WARN" if n % 7 == 0 else "INFO"
    return f"ST-RX {n:03d} level={level} code={n * 3}"


def tx(k: int) -> str:
    return f"ST-TX {k} get level=ERR" if k % 2 == 0 else f"ST-TX {k} ping"


# Arrival order: RX 1-30, TX 1-3, RX 31-60, TX 4-6
STREAM = ([("RX", rx(n)) for n in range(1, 31)] + [("TX", tx(k)) for k in (1, 2, 3)]
          + [("RX", rx(n)) for n in range(31, 61)] + [("TX", tx(k)) for k in (4, 5, 6)])


def expect(pattern: str, flags=0, only: str | None = None):
    rex = re.compile(pattern, flags)
    return [(d, t) for d, t in STREAM if rex.search(t) and (only is None or d == only)]


I = re.IGNORECASE
STEPS = [
    ("Literal search",
     "Search:  level=ERR      Aa: OFF   regex: OFF   filter: ALL",
     expect(re.escape("level=ERR"), I)),
    ("Match case",
     "Keep  level=ERR  in the search box, turn  Aa (match case)  ON",
     expect(re.escape("level=ERR"))),
    ("Regex alternation",
     "Aa OFF, regex ON.  Search:  level=(ERR|WARN)",
     expect(r"level=(ERR|WARN)", I)),
    ("Regex end-of-line",
     "Regex still ON.  Search:  code=\\d*5$",
     expect(r"code=\d*5$", I)),
    ("TX only",
     "Regex OFF.  Search:  level=ERR   and select  TX  in the panel",
     expect(re.escape("level=ERR"), I, "TX")),
    ("RX only",
     "Keep  level=ERR  in the search box, select  RX  in the panel",
     expect(re.escape("level=ERR"), I, "RX")),
]
SAVE_EXPECT = expect("ST-TX", I)


def compare(got: list[tuple[str, str]], want: list[tuple[str, str]]) -> bool:
    if got == want:
        print(f"    PASS — {len(got)} result line(s) match exactly")
        return True
    print(f"    FAIL — expected {len(want)} line(s), got {len(got)}")
    for i in range(max(len(want), len(got))):
        w = want[i] if i < len(want) else None
        g = got[i] if i < len(got) else None
        if w != g:
            print(f"      first difference at line {i + 1}:\n        expected: {w}\n        got:      {g}")
            break
    return False


def parse(text: str) -> list[tuple[str, str]] | None:
    out = []
    for ln in text.splitlines():
        if not ln.strip():
            continue
        m = RESULT.match(ln.rstrip())
        if not m:
            print(f"    FAIL — not in 'HH:MM:SS.mmm RX  text' form: {ln!r}")
            return None
        out.append((m[1], m[2]))
    return out


def check_clipboard(want) -> bool:
    raw = clipboard_get()
    if raw.strip() == SENTINEL:
        print("    FAIL — nothing was copied (clipboard unchanged)")
        return False
    got = parse(raw)
    return got is not None and compare(got, want)


def check_file(path: str, want) -> bool:
    try:
        with open(os.path.expanduser(path.strip().strip("'\"")), encoding="utf-8") as f:
            lines = f.read().splitlines()
    except OSError as e:
        print(f"    FAIL — cannot read file: {e}")
        return False
    if not lines or not lines[0].lower().startswith("# oryx search: st-tx"):  # search is case-insensitive
        print(f"    FAIL — missing header line, file starts with: {lines[:1]}")
        return False
    if f"{len(want)} lines, {len(want)} matches" not in lines[0]:
        print(f"    FAIL — header counts wrong: {lines[0]!r} (expected {len(want)} lines, {len(want)} matches)")
        return False
    got = parse("\n".join(lines[1:]))
    return got is not None and compare(got, want)


async def ask(prompt: str) -> str:
    return (await asyncio.to_thread(input, prompt)).strip()


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

        info = {"host": "search-test", "port_name": "TEST", "baud": 115200, "serial_connected": True}
        await send(M_INFO, json.dumps(info).encode())
        await asyncio.sleep(0.3)
        # RX rows go out in blocks; TX rows one frame each. The pauses keep
        # the RX/TX order on screen the same as the order sent.
        block: list[str] = []
        for direction, text in STREAM + [("END", "")]:
            if direction != "RX" and block:
                await send(M_DATA, "".join(t + "\r\n" for t in block).encode())
                block = []
                await asyncio.sleep(0.4)
            if direction == "RX":
                block.append(text)
            elif direction == "TX":
                await send(M_TX, (text + "\r\n").encode())
                await asyncio.sleep(0.15)
        if not connected.done():
            connected.set_result(True)
        async for frame in ws:
            kind, _ = ch.open(frame)
            if kind == M_PING:
                await send(M_PONG)

    async with serve(handler, "127.0.0.1", PORT, max_size=None, ping_interval=None):
        print(f"Waiting for ORYX — REMOTE tab, address 127.0.0.1:{PORT}, token {TOKEN}")
        await connected
        print("Connected, sent 60 RX and 6 TX rows. Use Text view.")
        print("Open the results panel with Ctrl/Cmd+Shift+F. In every step: set up the search,\n"
              "press the panel's COPY button (top right of the panel), then press Enter here.\n")
        results = []
        try:
            for i, (name, how, want) in enumerate(STEPS, 1):
                print(f"STEP {i}/{len(STEPS) + 1}: {name}\n    {how}\n    (panel header should read: {len(want)} lines)")
                while True:
                    clipboard_set(SENTINEL)
                    if (await ask("    Enter = check, s = skip: ")).lower() == "s":
                        results.append((name, None))
                        break
                    ok = check_clipboard(want)
                    if ok or (await ask("    Enter = try again, n = next step: ")).lower() == "n":
                        results.append((name, ok))
                        break
                print()
            name = "Save to file"
            print(f"STEP {len(STEPS) + 1}/{len(STEPS) + 1}: {name}\n    Select ALL in the panel. Search:  ST-TX   then press the panel's SAVE button\n"
                  "    and save the file anywhere.")
            while True:
                path = await ask("    Drag the saved file here (or type its path), s = skip: ")
                if path.lower() == "s":
                    results.append((name, None))
                    break
                ok = check_file(path, SAVE_EXPECT)
                if ok or (await ask("    Enter = try again, n = finish: ")).lower() == "n":
                    results.append((name, ok))
                    break
        except EOFError:
            pass
        print("\nSummary:")
        for name, ok in results:
            print(f"  {'PASS' if ok else 'SKIP' if ok is None else 'FAIL'}  {name}")
        return 0 if results and all(ok for _, ok in results) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
