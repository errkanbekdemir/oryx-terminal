#!/usr/bin/env python3
"""
Reproduces the ANSI-colored boot log + sensor telemetry demo used for the
ORYX README screenshot. Sends the exact byte sequence over a serial port so
you can capture a fresh screenshot in ORYX (Text view, no timestamps needed).

Requires: pip install pyserial

Usage:
    python3 ansi_demo.py <port> [baud]
    python3 ansi_demo.py /dev/ttys005 115200

To generate a port without real hardware (macOS/Linux), open a virtual
loopback pair first, then point this script at one end and ORYX at the
other:
    socat -d -d pty,raw,echo=0 pty,raw,echo=0
    # socat prints two paths like /dev/ttys004 and /dev/ttys005 — connect
    # ORYX to one, and run this script against the other.
"""
import sys
import time
import serial

ESC = "\x1b["
RESET = f"{ESC}0m"


def c(code: str, text: str) -> str:
    return f"{ESC}{code}m{text}{RESET}"


LINES = [
    c("1", "ORYX Serial Terminal"),
    c("90", "v1.8.0"),
    c("90", "─" * 30),
    f"[ {c('32', 'OK')}   ] GPIO subsystem",
    f"[ {c('32', 'OK')}   ] UART0 @ 115200 baud",
    f"[{c('33', 'WARN')} ] I2C bus – no ACK on 0x3C",
    f"[{c('31', 'FAIL')} ] BMP280 sensor timeout",
    "",
    c("90", "─" * 30),
    f"{c('36', 'TEMP')}   24.7 °C   {c('32', '▲ +0.2')}",
    f"{c('36', 'HUMID')}  61.3 %    {c('31', '▼ -1.1')}",
    f"{c('36', 'PRESS')}  1013 hPa  {c('90', '– 0.0')}",
    f"{c('33', 'VBAT')}   3.71 V    {c('31', '▼ -0.03')}",
    "",
    c("90", "uptime: 00:04:32   free heap: 142 KB"),
]


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    port = sys.argv[1]
    baud = int(sys.argv[2]) if len(sys.argv) > 2 else 115200

    with serial.Serial(port, baud, timeout=1) as ser:
        for line in LINES:
            ser.write((line + "\r\n").encode("utf-8"))
            ser.flush()
            time.sleep(0.05)


if __name__ == "__main__":
    main()
