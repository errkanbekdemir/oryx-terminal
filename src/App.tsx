import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTauriEvent } from './hooks/useTauriEvent';
import { documentDir, join } from '@tauri-apps/api/path';
import { ConnectionPanel } from './components/ConnectionPanel';
import { StatusBar } from './components/StatusBar';
import { SettingsPanel } from './components/SettingsPanel';
import { Terminal, LogEntry } from './components/Terminal';
import { Sender, parseInput } from './components/Sender';
import { MacroPanel, Macro, MacroLineEnding } from './components/MacroPanel';
import { ErrorBoundary } from './components/ErrorBoundary';
import { HelpOverlay } from './components/HelpOverlay';
import { useSettings } from './contexts/SettingsContext';
import { parseAnsi, AnsiState, DEFAULT_ANSI_STATE } from './utils/ansiParser';
import './App.css';

interface SerialPayload {
  data: number[];
  /** ms since the epoch when the chunk's last byte was read from the port (Rust) */
  ts?: number;
  /** ms per byte on the wire, to date the chunk's earlier bytes */
  byte_ms?: number;
}

interface RemoteConnectResult {
  address: string;
  info: { host: string; port_name: string; baud: number; serial_connected: boolean };
}

// ─── Module-level pure helpers ────────────────────────────────────────────────

const generateId = () =>
  Math.random().toString(36).substring(2, 9) + Date.now().toString(36);

const getTimestamp = (at?: number) => {
  const now = at === undefined ? new Date() : new Date(at);
  return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}.${now.getMilliseconds().toString().padStart(3, '0')}`;
};

function formatLogLine(type: 'rx' | 'tx', bytes: number[], viewMode: string, timestamp: string = getTimestamp()): string {
  let formatted: string;
  switch (viewMode) {
    case 'hex':
      formatted = bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
      break;
    case 'dec':
      formatted = bytes.map(b => b.toString(10).padStart(3, '0')).join(' ');
      break;
    case 'bin':
      formatted = bytes.map(b => b.toString(2).padStart(8, '0')).join(' ');
      break;
    case 'oct':
      formatted = bytes.map(b => b.toString(8).padStart(3, '0')).join(' ');
      break;
    case 'char':
      formatted = bytes.map(b => (b >= 0x20 && b <= 0x7E) ? String.fromCharCode(b) : '.').join(' ');
      break;
    default: // text
      formatted = bytes.map(b => {
        if (b === 0x0D) return '\\r';
        if (b === 0x0A) return '\\n';
        if (b === 0x09) return '\\t';
        if (b >= 0x20 && b <= 0x7E) return String.fromCharCode(b);
        return '.';
      }).join('');
      break;
  }
  return `[${timestamp}] ${type.toUpperCase()}  ${formatted}\n`;
}

// An RX line still waiting for its EOL is shown early but kept "open"; past
// this size it is closed anyway so a stream with no EOL can't grow one line
// forever. Large enough for big timeout-delimited binary frames.
const MAX_OPEN_LINE = 65536;

// Hard cap on raw RX bytes awaiting flush — beyond this the oldest bytes are
// dropped so a stalled flush (e.g. slow log write) can't grow memory unbounded.
const MAX_BUFFER = 1_048_576;

// Auto-generated log filenames; user-chosen paths never match and are reused as-is
const AUTO_LOG_RE = /^session_log_\d{8}_\d{6}\.txt$/;

const generateLogPath = async (): Promise<string> => {
  const docDir = await documentDir();
  const now = new Date();
  const timestamp = `${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}_${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}${now.getSeconds().toString().padStart(2, '0')}`;
  return join(docDir, 'ORYX_Logs', `session_log_${timestamp}.txt`);
};

// Display buffer: lines + how many were trimmed off the front. `trimmed` feeds
// Virtuoso's firstItemIndex so auto-scroll keeps working once the cap is hit.
interface TerminalBuffer {
  lines: LogEntry[];
  trimmed: number;
}

function pushLines(prev: TerminalBuffer, entries: LogEntry[], max: number): TerminalBuffer {
  const next = [...prev.lines, ...entries];
  if (next.length > max) {
    const overflow = next.length - max;
    return { lines: next.slice(overflow), trimmed: prev.trimmed + overflow };
  }
  return { lines: next, trimmed: prev.trimmed };
}

// ─────────────────────────────────────────────────────────────────────────────

function App() {
  const {
    viewMode, autoScroll, setAutoScroll, alwaysOnTop, showMacros, setShowMacros,
    macroWidth, setMacroWidth, showTimestamp, setShowTimestamp,
    showEol, eolSequence, breakMode, breakAfterBytesCount,
    breakBeforeSequenceValue, breakBeforeSequenceEnabled,
    breakAfterSequenceValue, breakAfterSequenceEnabled, breakAfterTimeoutMs,
    dataBits, stopBits, parity, flowControl, invertRts, invertDtr,
    invertCts, invertDsr, invertCd, invertRi, rs485PreDelayMs, rs485PostDelayMs,
    halfDuplexPreDelayMs, halfDuplexPostDelayMs,
    setSelectedPort, logPath, setLogPath,
    isLogging, setIsLogging, autoReconnect, reconnectTimeoutSec,
    maxLines,
  } = useSettings();

  const [termBuf, setTermBuf] = useState<TerminalBuffer>({ lines: [], trimmed: 0 });
  const lines = termBuf.lines;
  const [isConnected, setIsConnected] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [reconnectElapsed, setReconnectElapsed] = useState(0);
  const [isResizing, setIsResizing] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  // Set while connected to another Oryx's share instead of a local port
  const [remoteLabel, setRemoteLabel] = useState<string | null>(null);
  useEffect(() => {
    if (!isConnected && !isReconnecting) setRemoteLabel(null);
  }, [isConnected, isReconnecting]);

  // Buffers
  const bufferRef = useRef<number[]>([]);
  const lastFlushTime = useRef<number>(0);
  const flushInProgressRef = useRef(false);
  const viewModeRef = useRef(viewMode);
  // SGR state (color/bold/underline) in effect at the end of the last line
  // appended — carried into the next line so a color set once keeps applying
  // to later plain lines instead of resetting every line boundary.
  const ansiStateRef = useRef<AnsiState>(DEFAULT_ANSI_STATE);

  // Refs for logging and line breaking (hot-path access avoids stale closures)
  const isLoggingRef = useRef(false);
  const logPathRef = useRef('session_log.txt');
  const lastReceiveTime = useRef<number>(0);

  // Reconnect refs (display only — actual reconnect runs in Rust)
  const reconnectElapsedIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectStartTimeRef = useRef<number>(0);
  const autoReconnectRef = useRef(autoReconnect);
  const reconnectTimeoutSecRef = useRef(reconnectTimeoutSec);

  // Connection ref for hotkey handler (avoids stale closure)
  const isConnectedRef = useRef(isConnected);

  // Display limit ref (hot-path access from addLog)
  const maxLinesRef = useRef(maxLines);
  useEffect(() => { maxLinesRef.current = maxLines; }, [maxLines]);

  // Line breaking refs
  const breakModeRef = useRef(breakMode);
  const breakAfterBytesCountRef = useRef(breakAfterBytesCount);
  const breakBeforeSequenceValueRef = useRef(breakBeforeSequenceValue);
  const breakBeforeSequenceEnabledRef = useRef(breakBeforeSequenceEnabled);
  const breakAfterSequenceValueRef = useRef(breakAfterSequenceValue);
  const breakAfterSequenceEnabledRef = useRef(breakAfterSequenceEnabled);
  const breakAfterTimeoutMsRef = useRef(breakAfterTimeoutMs);
  const eolSequenceRef = useRef(eolSequence);
  const showEolRef = useRef(showEol);

  // ─── Keep the OS window pinned above others in sync with the setting ──────
  // Runs on mount too, so a persisted "on" from a previous session is
  // re-applied — window state itself isn't persisted by the OS/Tauri.
  useEffect(() => {
    invoke('set_always_on_top', { on: alwaysOnTop }).catch(e => console.error('Failed to set always-on-top:', e));
  }, [alwaysOnTop]);

  // ─── Initialize default log path when none is saved ───────────────────────
  useEffect(() => {
    if (logPath) return;
    const init = async () => {
      try {
        setLogPath(await generateLogPath());
      } catch (e) {
        console.error('Failed to resolve default log path:', e);
        setLogPath('session_log.txt');
      }
    };
    init();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Sync context values → hot-path refs ──────────────────────────────────
  useEffect(() => {
    viewModeRef.current = viewMode;
  }, [viewMode]);

  useEffect(() => {
    isConnectedRef.current = isConnected;
  }, [isConnected]);

  useEffect(() => {
    const wasLogging = isLoggingRef.current;
    if (isLogging && !wasLogging) {
      // Each logging session gets its own timestamped file. A custom path the
      // user picked via Settings never matches AUTO_LOG_RE and is reused as-is.
      const startLogging = async () => {
        let path = logPath;
        const basename = path ? path.replace(/^.*[\\/]/, '') : '';
        if (!path || AUTO_LOG_RE.test(basename)) {
          try {
            logPathRef.current = ''; // don't append to the previous session's file meanwhile
            path = await generateLogPath();
            logPathRef.current = path;
            setLogPath(path);
          } catch (e) {
            console.error('Failed to generate log path:', e);
            path = logPath;
            logPathRef.current = path;
          }
        }
        if (path) {
          const header = `\n--- Logging started at ${new Date().toLocaleString()} ---\n`;
          const encoded = Array.from(new TextEncoder().encode(header));
          invoke('log_to_file', { path, data: encoded }).catch(e => console.error('Failed to write log header:', e));
        }
      };
      startLogging();
    }
    isLoggingRef.current = isLogging;
    if (!(isLogging && !wasLogging)) {
      // Skip during session start: startLogging owns the ref until the new path resolves
      logPathRef.current = logPath;
    }
    breakModeRef.current = breakMode;
    breakAfterBytesCountRef.current = breakAfterBytesCount;
    breakBeforeSequenceValueRef.current = breakBeforeSequenceValue;
    breakBeforeSequenceEnabledRef.current = breakBeforeSequenceEnabled;
    breakAfterSequenceValueRef.current = breakAfterSequenceValue;
    breakAfterSequenceEnabledRef.current = breakAfterSequenceEnabled;
    breakAfterTimeoutMsRef.current = breakAfterTimeoutMs;
    eolSequenceRef.current = eolSequence;
    showEolRef.current = showEol;
    autoReconnectRef.current = autoReconnect;
    reconnectTimeoutSecRef.current = reconnectTimeoutSec;
  }, [isLogging, logPath, breakMode, breakAfterBytesCount, breakBeforeSequenceValue, breakBeforeSequenceEnabled, breakAfterSequenceValue, breakAfterSequenceEnabled, breakAfterTimeoutMs, eolSequence, showEol, autoReconnect, reconnectTimeoutSec]);

  // ─── Macro panel resize drag ───────────────────────────────────────────────
  useEffect(() => {
    if (!isResizing) return;
    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = Math.max(200, Math.min(window.innerWidth - 300, window.innerWidth - e.clientX));
      setMacroWidth(newWidth);
    };
    const handleMouseUp = () => setIsResizing(false);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, setMacroWidth]);

  const pendingLinesRef = useRef<LogEntry[]>([]);
  // RX arrival times: one mark per serial-data chunk, addressed by offset in
  // the RX byte stream. bufferRef[0] is always at stream offset rxConsumedRef.
  const rxTotalRef = useRef(0);
  const rxConsumedRef = useRef(0);
  const rxMarksRef = useRef<{ end: number; ts: number; byteMs: number }[]>([]);
  const addLog = useCallback((text: string, type: LogEntry['type'], originalData?: number[], at?: number): LogEntry => {
    const ansiStart = ansiStateRef.current;
    ansiStateRef.current = parseAnsi(text, ansiStart).state;
    const entry: LogEntry = { id: generateId(), timestamp: getTimestamp(at), type, text, originalData, ansiStart };
    // One state update per burst instead of one array copy per line —
    // with a large display limit, per-line copies made fast streams crawl.
    pendingLinesRef.current.push(entry);
    if (pendingLinesRef.current.length === 1) {
      queueMicrotask(() => {
        const batch = pendingLinesRef.current.splice(0);
        if (batch.length > 0) setTermBuf(prev => pushLines(prev, batch, maxLinesRef.current));
      });
    }
    return entry;
  }, []);

  // The RX line currently on screen without its EOL. Its bytes stay at the
  // head of bufferRef until the line completes, so break detection always
  // sees the whole line (an EOL split across flushes still matches).
  const openRxRef = useRef<{ id: string; ansiStart: AnsiState; timestamp: string; shown: number } | null>(null);

  // ─── Buffer flush ─────────────────────────────────────────────────────────
  // useCallback with stable deps (all reads go through refs) prevents stale closures
  // and ensures the setInterval always calls the same function reference.
  // 'wait': only emit complete lines. 'partial': also show an incomplete
  // trailing line (RX idle) but keep it open. 'complete': close it (break
  // timeout, disconnect).
  const flushBuffer = useCallback(async (mode: 'wait' | 'partial' | 'complete' = 'wait') => {
    if (bufferRef.current.length === 0) return;
    // Buffer holds only the already-shown open line: nothing new to scan
    if (mode !== 'complete' && bufferRef.current.length === openRxRef.current?.shown) return;

    // Guard: prevent concurrent async flushes (e.g. when log_to_file awaits > 16ms)
    if (flushInProgressRef.current) return;
    flushInProgressRef.current = true;

    try {
      // Atomically take all current bytes and clear the buffer in one step.
      // Any bytes pushed by serial-data events during a subsequent `await`
      // land in the now-empty bufferRef and are preserved — not overwritten.
      const snapshot = bufferRef.current.splice(0);
      const data = Uint8Array.from(snapshot);
      const base = rxConsumedRef.current; // stream offset of data[0]

      // When the byte at `index` of this snapshot arrived: its chunk was
      // read at mark.ts, and it left the wire byteMs earlier per byte that
      // follows it in the chunk — but not before the previous chunk was read.
      const marks = rxMarksRef.current;
      let markIdx = 0;
      const arrivalOf = (index: number): number | undefined => {
        const abs = base + index;
        while (markIdx < marks.length && marks[markIdx].end <= abs) markIdx++;
        const m = marks[markIdx];
        if (!m) return undefined;
        const t = m.ts - (m.end - 1 - abs) * m.byteMs;
        return markIdx > 0 ? Math.max(t, marks[markIdx - 1].ts) : t;
      };
      lastFlushTime.current = Date.now();

      const breakPoints: number[] = [];
      const currentViewMode = viewModeRef.current;

      if (currentViewMode === 'text') {
        try {
          const eolBytes = parseInput(eolSequenceRef.current);
          if (eolBytes.length > 0) {
            for (let i = 0; i <= data.length - eolBytes.length; i++) {
              let match = true;
              for (let j = 0; j < eolBytes.length; j++) {
                if (data[i + j] !== eolBytes[j]) { match = false; break; }
              }
              if (match) breakPoints.push(i + eolBytes.length);
            }
          }
        } catch (e) {
          console.error('Failed to parse EOL sequence:', e);
        }
      } else {
        if (breakModeRef.current === 'chunk') breakPoints.push(data.length);

        if (breakModeRef.current === 'bytes') {
          const byteCount = breakAfterBytesCountRef.current;
          // Guard against 0 or negative values which would cause an infinite loop
          if (byteCount > 0) {
            for (let i = byteCount; i <= data.length; i += byteCount) breakPoints.push(i);
          }
        }

        if (breakBeforeSequenceEnabledRef.current && breakBeforeSequenceValueRef.current) {
          try {
            const sequenceBytes = parseInput(breakBeforeSequenceValueRef.current);
            if (sequenceBytes.length > 0) {
              for (let i = 0; i <= data.length - sequenceBytes.length; i++) {
                let match = true;
                for (let j = 0; j < sequenceBytes.length; j++) {
                  if (data[i + j] !== sequenceBytes[j]) { match = false; break; }
                }
                if (match && i > 0) breakPoints.push(i);
              }
            }
          } catch (e) { console.error('Failed to parse break-before sequence:', e); }
        }

        if (breakAfterSequenceEnabledRef.current && breakAfterSequenceValueRef.current) {
          try {
            const sequenceBytes = parseInput(breakAfterSequenceValueRef.current);
            if (sequenceBytes.length > 0) {
              for (let i = 0; i <= data.length - sequenceBytes.length; i++) {
                let match = true;
                for (let j = 0; j < sequenceBytes.length; j++) {
                  if (data[i + j] !== sequenceBytes[j]) { match = false; break; }
                }
                if (match) breakPoints.push(i + sequenceBytes.length);
              }
            }
          } catch (e) { console.error('Failed to parse break-after sequence:', e); }
        }

        // Global EOL sequence also applies in binary modes
        try {
          const eolBytes = parseInput(eolSequenceRef.current);
          if (eolBytes.length > 0) {
            for (let i = 0; i <= data.length - eolBytes.length; i++) {
              let match = true;
              for (let j = 0; j < eolBytes.length; j++) {
                if (data[i + j] !== eolBytes[j]) { match = false; break; }
              }
              if (match) breakPoints.push(i + eolBytes.length);
            }
          }
        } catch (e) { console.error('Failed to parse EOL sequence:', e); }
      }

      const uniqueBreakPoints = Array.from(new Set(breakPoints)).sort((a, b) => a - b);

      // Process segments + collect log lines
      const logLines: string[] = [];

      // Show `bytes` as RX. Updates the open line in place if there is one;
      // `keepOpen` leaves it open for more bytes, otherwise it's finished
      // and written to the log file (stamped with the time the line began).
      const showRx = (bytes: number[], keepOpen: boolean, start: number) => {
        const text = new TextDecoder().decode(Uint8Array.from(bytes));
        const open = openRxRef.current;
        if (open) {
          ansiStateRef.current = parseAnsi(text, open.ansiStart).state;
          const updated: LogEntry = { id: open.id, timestamp: open.timestamp, type: 'rx', text, originalData: bytes, ansiStart: open.ansiStart };
          const queued = pendingLinesRef.current.findIndex(l => l.id === open.id);
          if (queued !== -1) pendingLinesRef.current[queued] = updated; // not in state yet
          else setTermBuf(prev => {
            // Usually the last line, but TX/system lines may have landed after it
            for (let i = prev.lines.length - 1; i >= Math.max(0, prev.lines.length - 64); i--) {
              if (prev.lines[i].id === open.id) {
                const lines = prev.lines.slice();
                lines[i] = updated;
                return { lines, trimmed: prev.trimmed };
              }
            }
            return pushLines(prev, [updated], maxLinesRef.current); // cleared/trimmed meanwhile
          });
          openRxRef.current = keepOpen ? { ...open, shown: bytes.length } : null;
          if (!keepOpen && isLoggingRef.current) logLines.push(formatLogLine('rx', bytes, currentViewMode, open.timestamp));
        } else {
          const entry = addLog(text, 'rx', bytes, arrivalOf(start));
          if (keepOpen) {
            openRxRef.current = { id: entry.id, ansiStart: entry.ansiStart ?? DEFAULT_ANSI_STATE, timestamp: entry.timestamp, shown: bytes.length };
          } else if (isLoggingRef.current) {
            logLines.push(formatLogLine('rx', bytes, currentViewMode, entry.timestamp));
          }
        }
      };

      let lastIndex = 0;
      for (const breakPoint of uniqueBreakPoints) {
        if (breakPoint > lastIndex && breakPoint <= data.length) {
          showRx(Array.from(data.slice(lastIndex, breakPoint)), false, lastIndex);
          lastIndex = breakPoint;
        }
      }
      const remaining = Array.from(data.slice(lastIndex));
      let consumed = lastIndex;
      if (remaining.length > 0) {
        if (mode === 'complete' || remaining.length >= MAX_OPEN_LINE) {
          showRx(remaining, false, lastIndex);
          consumed = data.length;
        } else {
          if (mode === 'partial' && remaining.length !== openRxRef.current?.shown) {
            showRx(remaining, true, lastIndex);
          }
          // Not consumed: stays ahead of any bytes that arrived meanwhile,
          // to be re-evaluated (and the open line updated) on the next flush
          bufferRef.current = [...remaining, ...bufferRef.current];
        }
      }
      rxConsumedRef.current = base + consumed;
      // Keep the mark covering the first unconsumed byte and the one before it (the clamp)
      let keepFrom = 0;
      while (keepFrom < marks.length && marks[keepFrom].end <= rxConsumedRef.current) keepFrom++;
      if (keepFrom > 1) marks.splice(0, keepFrom - 1);

      // Batch write formatted log lines
      if (logLines.length > 0 && logPathRef.current) {
        const encoded = Array.from(new TextEncoder().encode(logLines.join('')));
        try {
          await invoke('log_to_file', { path: logPathRef.current, data: encoded });
        } catch (e) {
          console.error('Failed to log:', e);
          addLog(`Log Error: ${e}`, 'error');
          setIsLogging(false);
        }
      }
    } finally {
      flushInProgressRef.current = false;
    }
  }, [addLog, setIsLogging]);

  // ─── Welcome message + connection status sync (run once on mount) ─────────
  const hasLoggedWelcome = useRef(false);
  useEffect(() => {
    if (!hasLoggedWelcome.current) {
      addLog('Welcome to Oryx Serial Terminal. Ready to connect.', 'system');
      addLog('Select a view mode below (Text, Hex, Bin, etc).', 'system');
      hasLoggedWelcome.current = true;
    }
    const syncConnection = async () => {
      try {
        const activePort = await invoke<string | null>('get_connection_status');
        if (activePort) {
          setIsConnected(true);
          setSelectedPort(activePort);
          addLog(`Detected active connection to ${activePort}.`, 'system');
        }
      } catch (e) { console.error('Failed to sync connection status:', e); }
    };
    syncConnection();
  }, [addLog]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Serial data listener ─────────────────────────────────────────────────
  useTauriEvent<SerialPayload>('serial-data', (payload) => {
    // Indexed loop, not push(...spread): a large payload as spread arguments
    // overflows the call stack (RangeError) — the reconnect-burst crash.
    const buf = bufferRef.current;
    const data = payload.data;
    for (let i = 0; i < data.length; i++) buf.push(data[i]);
    rxTotalRef.current += data.length;
    rxMarksRef.current.push({ end: rxTotalRef.current, ts: payload.ts ?? Date.now(), byteMs: payload.byte_ms ?? 0 });
    if (buf.length > MAX_BUFFER) {
      const dropped = buf.length - MAX_BUFFER;
      buf.splice(0, dropped);
      rxConsumedRef.current += dropped;
    }
    lastReceiveTime.current = Date.now();
  });

  // TX made on the other end of a network share (the sharer's own sends, or
  // the remote client's sends as seen by the sharer) — shown as TX here too
  useTauriEvent<SerialPayload>('remote-tx', (payload) => {
    const bytes = payload.data;
    addLog(new TextDecoder().decode(new Uint8Array(bytes)), 'tx', bytes);
    if (isLoggingRef.current && logPathRef.current) {
      const encoded = Array.from(new TextEncoder().encode(formatLogLine('tx', bytes, viewModeRef.current)));
      invoke('log_to_file', { path: logPathRef.current, data: encoded }).catch(e => console.error('TX log error:', e));
    }
  });

  // ─── Disconnect / reconnect listeners ─────────────────────────────────────
  useTauriEvent('serial-disconnected', () => {
    flushBuffer('complete'); // close a pending partial line before the notice
    setIsConnected(false);
    ansiStateRef.current = DEFAULT_ANSI_STATE;
    addLog('[DISCONNECTED] Port unexpectedly closed.', 'error');

    if (!autoReconnectRef.current) {
      invoke('close_port').catch(() => {});
      return;
    }

    setIsReconnecting(true);
    reconnectStartTimeRef.current = Date.now();
    setReconnectElapsed(0);
    addLog('[RECONNECT] Reconnecting automatically...', 'system');

    reconnectElapsedIntervalRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - reconnectStartTimeRef.current) / 1000);
      setReconnectElapsed(elapsed);

      if (reconnectTimeoutSecRef.current > 0 && elapsed >= reconnectTimeoutSecRef.current) {
        clearInterval(reconnectElapsedIntervalRef.current!);
        reconnectElapsedIntervalRef.current = null;
        setIsReconnecting(false);
        setReconnectElapsed(0);
        invoke('close_port').catch(() => {});
        addLog(`[RECONNECT FAILED] Timed out after ${reconnectTimeoutSecRef.current}s.`, 'error');
      }
    }, 1000);
  });

  useTauriEvent<string>('serial-reconnected', (portName) => {
    if (reconnectElapsedIntervalRef.current) {
      clearInterval(reconnectElapsedIntervalRef.current);
      reconnectElapsedIntervalRef.current = null;
    }
    setIsReconnecting(false);
    setReconnectElapsed(0);
    setIsConnected(true);
    if (portName) setSelectedPort(portName);
    addLog('[RECONNECTED] Successfully reconnected.', 'system');
  });

  // Clear the reconnect elapsed interval if the component unmounts mid-reconnect
  useEffect(() => {
    return () => {
      if (reconnectElapsedIntervalRef.current) {
        clearInterval(reconnectElapsedIntervalRef.current);
        reconnectElapsedIntervalRef.current = null;
      }
    };
  }, []);

  // ─── Save-to-macro window event ───────────────────────────────────────────
  useEffect(() => {
    const handleSaveToMacro = () => setShowMacros(true);
    window.addEventListener('oryx-add-macro', handleSaveToMacro);
    return () => window.removeEventListener('oryx-add-macro', handleSaveToMacro);
  }, [setShowMacros]);

  // ─── Buffer flush interval (60 fps) ───────────────────────────────────────
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();

      if (breakModeRef.current === 'timeout' && bufferRef.current.length > 0) {
        if (now - lastReceiveTime.current > breakAfterTimeoutMsRef.current) {
          flushBuffer('complete');
          return;
        }
      }

      if (bufferRef.current.length > 0) {
        // An incomplete line (no matching EOL yet) is shown once RX has been
        // idle this long, so prompts appear promptly — but as an open line
        // that the rest of the line is appended to, not a line break.
        const partialAfterMs = 50;
        const isStale = now - lastReceiveTime.current > partialAfterMs;
        // A stream that never matches the EOL/break sequence is still shown
        // (and the open line closed at MAX_OPEN_LINE) instead of buffering forever.
        const isOversize = bufferRef.current.length > MAX_OPEN_LINE;
        flushBuffer(isStale || isOversize ? 'partial' : 'wait');
      }
    }, 16);
    return () => clearInterval(interval);
  }, [flushBuffer]);

  // ─── Global keyboard shortcuts ────────────────────────────────────────────
  const handleClear = useCallback(() => {
    // Fold the cleared lines into `trimmed` so Virtuoso's firstItemIndex stays monotonic
    pendingLinesRef.current.length = 0;
    setTermBuf(prev => ({ lines: [], trimmed: prev.trimmed + prev.lines.length }));
    openRxRef.current = null;
    ansiStateRef.current = DEFAULT_ANSI_STATE;
    addLog('Logs cleared.', 'system');
  }, [addLog]);

  // Load macros from localStorage for hotkey detection
  const getMacros = (): Macro[] => {
    try {
      const saved = localStorage.getItem('oryx_macros');
      if (saved) {
        const parsed: Macro[] = JSON.parse(saved);
        return parsed || [];
      }
    } catch (e) {
      console.error('Failed to load macros for hotkey detection:', e);
    }
    return [];
  };

  // ─── Handlers ─────────────────────────────────────────────────────────────

  const handleConnect = async (port: string, baud: number) => {
    try {
      await invoke('open_port', { portName: port, baudRate: baud, dataBits, stopBits, parity, flowControl, invertRts, invertDtr, invertCts, invertDsr, invertCd, invertRi, rs485PreDelayMs, rs485PostDelayMs, halfDuplexPreDelayMs, halfDuplexPostDelayMs });
      setIsConnected(true);
      ansiStateRef.current = DEFAULT_ANSI_STATE;
      addLog(`Connected to ${port} at ${baud} baud (${dataBits}${parity.charAt(0).toUpperCase()}${stopBits}).`, 'system');
    } catch (e) {
      console.error(e);
      addLog(`Failed to connect: ${e}`, 'error');
    }
  };

  const handleConnectRemote = async (address: string, token: string) => {
    addLog(`Connecting to remote share ${address}...`, 'system');
    try {
      const res = await invoke<RemoteConnectResult>('connect_remote', { address, token });
      setRemoteLabel(`${res.info.port_name} @ ${res.address}`);
      setIsConnected(true);
      ansiStateRef.current = DEFAULT_ANSI_STATE;
      addLog(`Connected to remote share ${res.address} — ${res.info.port_name} at ${res.info.baud} baud on ${res.info.host} (encrypted).`, 'system');
      if (!res.info.serial_connected) {
        addLog('[REMOTE] The shared serial port is currently disconnected on the remote side.', 'error');
      }
    } catch (e) {
      if (String(e) === 'Connection cancelled') addLog('Connection cancelled.', 'system');
      else addLog(`Failed to connect to remote: ${e}`, 'error');
    }
  };

  // close_port also aborts an in-flight remote handshake
  const handleCancelConnect = () => {
    invoke('close_port').catch(e => console.error('Failed to cancel connect:', e));
  };

  const handleDisconnect = async () => {
    if (reconnectElapsedIntervalRef.current) {
      clearInterval(reconnectElapsedIntervalRef.current);
      reconnectElapsedIntervalRef.current = null;
    }
    setIsReconnecting(false);
    setReconnectElapsed(0);
    try {
      await invoke('close_port');
      flushBuffer('complete');
      setIsConnected(false);
      ansiStateRef.current = DEFAULT_ANSI_STATE;
      addLog('Disconnected.', 'system');
    } catch (e) { console.error(e); }
  };

  const handleMacroRun = useCallback(async (command: string, lineEnding?: MacroLineEnding): Promise<boolean> => {
    if (!isConnectedRef.current) {
      addLog('Cannot send: Not connected.', 'error');
      return false;
    }
    let dataBytes: number[];
    try {
      dataBytes = parseInput(command);
    } catch (e) {
      addLog(`Cannot send "${command}": ${(e as Error).message}`, 'error');
      return false;
    }
    if (lineEnding === 'CR') dataBytes.push(13);
    else if (lineEnding === 'LF') dataBytes.push(10);
    else if (lineEnding === 'CRLF') dataBytes.push(13, 10);
    try {
      await invoke('send_data', { data: dataBytes });
      addLog(command, 'tx', dataBytes);
      if (isLoggingRef.current && logPathRef.current) {
        const encoded = Array.from(new TextEncoder().encode(formatLogLine('tx', dataBytes, viewModeRef.current)));
        invoke('log_to_file', { path: logPathRef.current, data: encoded }).catch(e => console.error('TX log error:', e));
      }
      return true;
    } catch (e) {
      addLog(`Failed to send macro: ${e}`, 'error');
      return false;
    }
  }, [addLog]);

  // ─── Keyboard shortcuts ───────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey; // ⌘ on macOS
      if (mod && key === 'l') {
        e.preventDefault();
        handleClear();
      } else if (key === '?' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const target = e.target as HTMLElement;
        if (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA') {
          setIsHelpOpen(true);
        }
      } else if (mod && !e.altKey && !e.shiftKey) {
        // Check for macro hotkeys (Ctrl/⌘+1 through 9)
        const hotkeyNum = parseInt(key, 10);
        if (hotkeyNum >= 1 && hotkeyNum <= 9) {
          e.preventDefault();
          const macros = getMacros();
          const macro = macros.find(m => m.hotkey === hotkeyNum);
          if (macro) {
            handleMacroRun(macro.command, macro.lineEnding);
          }
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleClear, handleMacroRun]);

  return (
    <div className="flex flex-col h-screen w-screen bg-gray-100 dark:bg-[#1e1e1e] transition-colors duration-200 overflow-hidden">
      <ConnectionPanel
        isConnected={isConnected}
        isReconnecting={isReconnecting}
        onConnect={handleConnect}
        onConnectRemote={handleConnectRemote}
        onCancelConnect={handleCancelConnect}
        onDisconnect={handleDisconnect}
        onOpenSettings={() => setIsSettingsOpen(true)}
      />

      <div className="flex-grow flex overflow-hidden min-h-0">
        {/* Main Terminal Area */}
        <div className="flex-grow flex flex-col overflow-hidden relative min-w-0">
          <ErrorBoundary label="Terminal">
            <Terminal
              lines={lines}
              firstItemIndex={termBuf.trimmed}
              autoScroll={autoScroll}
              setAutoScroll={setAutoScroll}
              showTimestamp={showTimestamp}
              setShowTimestamp={setShowTimestamp}
              viewMode={viewMode}
              showEol={showEol}
              eolSequence={eolSequence}
              onClear={handleClear}
              onSendCommand={handleMacroRun}
            />
          </ErrorBoundary>
        </div>

        {/* Macro Sidebar */}
        {showMacros && (
          <div
            className="flex relative h-full bg-gray-50 dark:bg-[#181818]"
            style={{ width: `${macroWidth}px` }}
          >
            {/* Resize Handle */}
            <div
              className={`absolute left-0 top-0 bottom-0 w-1 cursor-col-resize z-[40] transition-colors hover:bg-blue-500/50 ${isResizing ? 'bg-blue-600' : ''}`}
              onMouseDown={() => setIsResizing(true)}
            />
            <div className="flex-grow min-w-0">
              <ErrorBoundary label="Macro Panel">
                <MacroPanel onRun={handleMacroRun} isConnected={isConnected} />
              </ErrorBoundary>
            </div>
          </div>
        )}
      </div>

      <Sender
        isConnected={isConnected}
        onSend={(text, data) => {
          addLog(text, 'tx', data);
          if (isLoggingRef.current && logPathRef.current) {
            const encoded = Array.from(new TextEncoder().encode(formatLogLine('tx', data, viewModeRef.current)));
            invoke('log_to_file', { path: logPathRef.current, data: encoded }).catch(e => console.error('TX log error:', e));
          }
        }}
      />

      <StatusBar
        isConnected={isConnected}
        isReconnecting={isReconnecting}
        reconnectElapsed={reconnectElapsed}
        remoteLabel={remoteLabel}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onClear={handleClear}
        onOpenHelp={() => setIsHelpOpen(true)}
      />

      <SettingsPanel
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        // Serial-only settings must not be pushed down a remote link
        isConnected={isConnected && !remoteLabel}
        isRemote={!!remoteLabel}
      />

      <HelpOverlay
        isOpen={isHelpOpen}
        onClose={() => setIsHelpOpen(false)}
      />
    </div>
  );
}

export default App;
