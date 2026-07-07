import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
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
import './App.css';

interface SerialPayload {
  data: number[];
}

// ─── Module-level pure helpers ────────────────────────────────────────────────

const generateId = () =>
  Math.random().toString(36).substring(2, 9) + Date.now().toString(36);

const getTimestamp = () => {
  const now = new Date();
  return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}.${now.getMilliseconds().toString().padStart(3, '0')}`;
};

function formatLogLine(type: 'rx' | 'tx', bytes: number[], viewMode: string): string {
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
  return `[${getTimestamp()}] ${type.toUpperCase()}  ${formatted}\n`;
}

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

// ─────────────────────────────────────────────────────────────────────────────

function App() {
  const {
    viewMode, autoScroll, setAutoScroll, showMacros, setShowMacros,
    macroWidth, setMacroWidth, showTimestamp, setShowTimestamp,
    showEol, eolSequence, breakMode, breakAfterBytesCount,
    breakBeforeSequenceValue, breakAfterSequenceValue, breakAfterTimeoutMs,
    dataBits, stopBits, parity, flowControl,
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
  const [hasSeenAnsi, setHasSeenAnsi] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);

  // Buffers
  const bufferRef = useRef<number[]>([]);
  const lastFlushTime = useRef<number>(0);
  const flushInProgressRef = useRef(false);
  const viewModeRef = useRef(viewMode);

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
  const breakAfterSequenceValueRef = useRef(breakAfterSequenceValue);
  const breakAfterTimeoutMsRef = useRef(breakAfterTimeoutMs);
  const eolSequenceRef = useRef(eolSequence);
  const showEolRef = useRef(showEol);

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
    breakAfterSequenceValueRef.current = breakAfterSequenceValue;
    breakAfterTimeoutMsRef.current = breakAfterTimeoutMs;
    eolSequenceRef.current = eolSequence;
    showEolRef.current = showEol;
    autoReconnectRef.current = autoReconnect;
    reconnectTimeoutSecRef.current = reconnectTimeoutSec;
  }, [isLogging, logPath, breakMode, breakAfterBytesCount, breakBeforeSequenceValue, breakAfterSequenceValue, breakAfterTimeoutMs, eolSequence, showEol, autoReconnect, reconnectTimeoutSec]);

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

  const addLog = useCallback((text: string, type: LogEntry['type'], originalData?: number[]) => {
    if (text.includes('\x1b')) setHasSeenAnsi(true);
    const entry: LogEntry = { id: generateId(), timestamp: getTimestamp(), type, text, originalData };
    setTermBuf(prev => {
      const next = [...prev.lines, entry];
      const max = maxLinesRef.current;
      if (next.length > max) {
        const overflow = next.length - max;
        return { lines: next.slice(overflow), trimmed: prev.trimmed + overflow };
      }
      return { lines: next, trimmed: prev.trimmed };
    });
  }, []);

  // ─── Buffer flush ─────────────────────────────────────────────────────────
  // useCallback with stable deps (all reads go through refs) prevents stale closures
  // and ensures the setInterval always calls the same function reference.
  const flushBuffer = useCallback(async (force: boolean = false) => {
    if (bufferRef.current.length === 0) return;

    // Guard: prevent concurrent async flushes (e.g. when log_to_file awaits > 16ms)
    if (flushInProgressRef.current) return;
    flushInProgressRef.current = true;

    try {
      // Atomically take all current bytes and clear the buffer in one step.
      // Any bytes pushed by serial-data events during a subsequent `await`
      // land in the now-empty bufferRef and are preserved — not overwritten.
      const snapshot = bufferRef.current.splice(0);
      const data = Uint8Array.from(snapshot);
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

        if (breakModeRef.current === 'beforeSequence' && breakBeforeSequenceValueRef.current) {
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

        if (breakModeRef.current === 'afterSequence' && breakAfterSequenceValueRef.current) {
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
      let lastIndex = 0;
      if (uniqueBreakPoints.length > 0) {
        for (const breakPoint of uniqueBreakPoints) {
          if (breakPoint > lastIndex && breakPoint <= data.length) {
            const segment = data.slice(lastIndex, breakPoint);
            addLog(new TextDecoder().decode(segment), 'rx', Array.from(segment));
            if (isLoggingRef.current) logLines.push(formatLogLine('rx', Array.from(segment), currentViewMode));
            lastIndex = breakPoint;
          }
        }
        const remaining = data.slice(lastIndex);
        if (force && remaining.length > 0) {
          addLog(new TextDecoder().decode(remaining), 'rx', Array.from(remaining));
          if (isLoggingRef.current) logLines.push(formatLogLine('rx', Array.from(remaining), currentViewMode));
          // remaining is consumed; keep any bytes that arrived during the await
        } else if (remaining.length > 0) {
          // Prepend unprocessed bytes before any new bytes that arrived during await
          bufferRef.current = [...Array.from(remaining), ...bufferRef.current];
        }
      } else if (force) {
        addLog(new TextDecoder().decode(data), 'rx', Array.from(data));
        if (isLoggingRef.current) logLines.push(formatLogLine('rx', Array.from(data), currentViewMode));
        // all data consumed; keep any bytes that arrived during the await
      } else {
        // No breakpoints and not forced: restore data before any new bytes
        bufferRef.current = [...Array.from(data), ...bufferRef.current];
      }

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
  useEffect(() => {
    const unlisten = listen<SerialPayload>('serial-data', (event) => {
      // Indexed loop, not push(...spread): a large payload as spread arguments
      // overflows the call stack (RangeError) — the reconnect-burst crash.
      const buf = bufferRef.current;
      const data = event.payload.data;
      for (let i = 0; i < data.length; i++) buf.push(data[i]);
      if (buf.length > MAX_BUFFER) {
        buf.splice(0, buf.length - MAX_BUFFER);
      }
      lastReceiveTime.current = Date.now();
    });
    return () => { unlisten.then(f => f()); };
  }, []);

  // ─── Disconnect / reconnect listeners ─────────────────────────────────────
  useEffect(() => {
    const unlistenDisconnect = listen('serial-disconnected', () => {
      setIsConnected(false);
      setHasSeenAnsi(false);
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

    const unlistenReconnected = listen<string>('serial-reconnected', (event) => {
      if (reconnectElapsedIntervalRef.current) {
        clearInterval(reconnectElapsedIntervalRef.current);
        reconnectElapsedIntervalRef.current = null;
      }
      setIsReconnecting(false);
      setReconnectElapsed(0);
      setIsConnected(true);
      // Restore selected port after reconnect
      if (event.payload) {
        setSelectedPort(event.payload);
      }
      addLog('[RECONNECTED] Successfully reconnected.', 'system');
    });

    return () => {
      unlistenDisconnect.then(f => f());
      unlistenReconnected.then(f => f());
      // Clear the reconnect elapsed interval if the component unmounts mid-reconnect
      if (reconnectElapsedIntervalRef.current) {
        clearInterval(reconnectElapsedIntervalRef.current);
        reconnectElapsedIntervalRef.current = null;
      }
    };
  }, [addLog]);

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
          flushBuffer(true);
          return;
        }
      }

      if (bufferRef.current.length > 0) {
        const forceFlushTimeout = viewModeRef.current === 'text' ? 1000 : 50;
        const isStale = now - lastReceiveTime.current > forceFlushTimeout;
        // Cap: force-flush if buffer exceeds 64 KB regardless of idle time.
        // Prevents unbounded growth when data streams continuously without
        // matching the EOL/break sequence (e.g. wrong EOL config in text mode).
        const isOversize = bufferRef.current.length > 65536;
        flushBuffer(isStale || isOversize);
      }
    }, 16);
    return () => clearInterval(interval);
  }, [flushBuffer]);

  // ─── Global keyboard shortcuts ────────────────────────────────────────────
  const handleClear = useCallback(() => {
    // Fold the cleared lines into `trimmed` so Virtuoso's firstItemIndex stays monotonic
    setTermBuf(prev => ({ lines: [], trimmed: prev.trimmed + prev.lines.length }));
    setHasSeenAnsi(false);
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
      await invoke('open_port', { portName: port, baudRate: baud, dataBits, stopBits, parity, flowControl });
      setIsConnected(true);
      setHasSeenAnsi(false);
      addLog(`Connected to ${port} at ${baud} baud (${dataBits}${parity.charAt(0).toUpperCase()}${stopBits}).`, 'system');
    } catch (e) {
      console.error(e);
      addLog(`Failed to connect: ${e}`, 'error');
    }
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
      setIsConnected(false);
      setHasSeenAnsi(false);
      addLog('Disconnected.', 'system');
    } catch (e) { console.error(e); }
  };

  const handleMacroRun = useCallback(async (command: string, lineEnding?: MacroLineEnding): Promise<boolean> => {
    if (!isConnectedRef.current) {
      addLog('Cannot send: Not connected.', 'error');
      return false;
    }
    const dataBytes = parseInput(command);
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
      if (e.ctrlKey && key === 'l') {
        e.preventDefault();
        handleClear();
      } else if (key === '?' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const target = e.target as HTMLElement;
        if (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA') {
          setIsHelpOpen(true);
        }
      } else if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        // Check for macro hotkeys (Ctrl+1 through Ctrl+9)
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
              hasSeenAnsi={hasSeenAnsi}
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
        onOpenSettings={() => setIsSettingsOpen(true)}
        onClear={handleClear}
        onOpenHelp={() => setIsHelpOpen(true)}
      />

      <SettingsPanel
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
      />

      <HelpOverlay
        isOpen={isHelpOpen}
        onClose={() => setIsHelpOpen(false)}
      />
    </div>
  );
}

export default App;
