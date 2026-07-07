import { createContext, useContext, useState, useEffect, ReactNode } from 'react';

export type ViewMode = 'text' | 'hex' | 'bin' | 'dec' | 'oct' | 'char';
export type BreakMode = 'none' | 'chunk' | 'bytes' | 'beforeSequence' | 'afterSequence' | 'timeout';

const getSaved = <T,>(key: string, fallback: T): T => {
    const saved = localStorage.getItem(key);
    if (saved === null) return fallback;
    try { return JSON.parse(saved) as T; } catch { return saved as unknown as T; }
};

interface SettingsContextType {
    // Display
    viewMode: ViewMode; setViewMode: (v: ViewMode) => void;
    theme: 'dark' | 'light'; setTheme: (v: 'dark' | 'light') => void;
    autoScroll: boolean; setAutoScroll: (v: boolean) => void;
    showMacros: boolean; setShowMacros: (v: boolean) => void;
    macroWidth: number; setMacroWidth: (v: number) => void;
    showTimestamp: boolean; setShowTimestamp: (v: boolean) => void;
    showEol: boolean; setShowEol: (v: boolean) => void;
    maxLines: number; setMaxLines: (v: number) => void;
    // Line breaking
    eolSequence: string; setEolSequence: (v: string) => void;
    breakMode: BreakMode; setBreakMode: (v: BreakMode) => void;
    breakAfterBytesCount: number; setBreakAfterBytesCount: (v: number) => void;
    breakBeforeSequenceValue: string; setBreakBeforeSequenceValue: (v: string) => void;
    breakAfterSequenceValue: string; setBreakAfterSequenceValue: (v: string) => void;
    breakAfterTimeoutMs: number; setBreakAfterTimeoutMs: (v: number) => void;
    // Serial config
    dataBits: number; setDataBits: (v: number) => void;
    stopBits: number; setStopBits: (v: number) => void;
    parity: string; setParity: (v: string) => void;
    flowControl: string; setFlowControl: (v: string) => void;
    selectedPort: string; setSelectedPort: (v: string) => void;
    // Logging
    logPath: string; setLogPath: (v: string) => void;
    isLogging: boolean; setIsLogging: (v: boolean) => void;
    // Reconnect
    autoReconnect: boolean; setAutoReconnect: (v: boolean) => void;
    reconnectTimeoutSec: number; setReconnectTimeoutSec: (v: number) => void;
}

const SettingsContext = createContext<SettingsContextType | null>(null);

export function useSettings(): SettingsContextType {
    const ctx = useContext(SettingsContext);
    if (!ctx) throw new Error('useSettings must be used inside <SettingsProvider>');
    return ctx;
}

export function SettingsProvider({ children }: { children: ReactNode }) {
    const [viewMode, setViewMode] = useState<ViewMode>(getSaved('oryx_viewMode', 'text'));
    const [theme, setTheme] = useState<'dark' | 'light'>(getSaved('oryx_theme', 'dark'));
    const [autoScroll, setAutoScroll] = useState(getSaved('oryx_autoScroll', true));
    const [showMacros, setShowMacros] = useState(getSaved('oryx_showMacros', false));
    const [macroWidth, setMacroWidth] = useState(getSaved('oryx_macroWidth', 256));
    const [showTimestamp, setShowTimestamp] = useState(getSaved('oryx_showTimestamp', true));
    const [showEol, setShowEol] = useState(getSaved('oryx_showEol', false));
    const [maxLines, setMaxLines] = useState(getSaved('oryx_maxLines', 10_000));

    const [eolSequence, setEolSequence] = useState(getSaved('oryx_eolSequence', '\\r\\n'));
    const [breakMode, setBreakMode] = useState<BreakMode>(getSaved('oryx_breakMode', 'beforeSequence'));
    const [breakAfterBytesCount, setBreakAfterBytesCount] = useState(getSaved('oryx_breakAfterBytesCount', 16));
    const [breakBeforeSequenceValue, setBreakBeforeSequenceValue] = useState(getSaved('oryx_breakBeforeSequenceValue', ''));
    const [breakAfterSequenceValue, setBreakAfterSequenceValue] = useState(getSaved('oryx_breakAfterSequenceValue', ''));
    const [breakAfterTimeoutMs, setBreakAfterTimeoutMs] = useState(getSaved('oryx_breakAfterTimeoutMs', 50));

    const [dataBits, setDataBits] = useState(getSaved('oryx_dataBits', 8));
    const [stopBits, setStopBits] = useState(getSaved('oryx_stopBits', 1));
    const [parity, setParity] = useState(getSaved('oryx_parity', 'None'));
    const [flowControl, setFlowControl] = useState(getSaved('oryx_flowControl', 'None'));
    const [selectedPort, setSelectedPort] = useState<string>(getSaved('oryx_selectedPort', ''));

    const [logPath, setLogPath] = useState(''); // Do not persist log path to generate a new one each session
    const [isLogging, setIsLogging] = useState(false); // session-only: intentionally not persisted

    const [autoReconnect, setAutoReconnect] = useState(getSaved('oryx_autoReconnect', true));
    const [reconnectTimeoutSec, setReconnectTimeoutSec] = useState(getSaved('oryx_reconnectTimeoutSec', 0));

    // Apply theme class to <html>
    useEffect(() => {
        document.documentElement.classList.toggle('dark', theme === 'dark');
        localStorage.setItem('oryx_theme', JSON.stringify(theme));
    }, [theme]);

    // Persist all settings
    useEffect(() => {
        const settings: Record<string, unknown> = {
            oryx_autoScroll: autoScroll,
            oryx_viewMode: viewMode,
            oryx_showMacros: showMacros,
            oryx_macroWidth: macroWidth,
            oryx_showTimestamp: showTimestamp,
            oryx_showEol: showEol,
            oryx_maxLines: maxLines,
            oryx_eolSequence: eolSequence,
            oryx_breakMode: breakMode,
            oryx_breakAfterBytesCount: breakAfterBytesCount,
            oryx_breakBeforeSequenceValue: breakBeforeSequenceValue,
            oryx_breakAfterSequenceValue: breakAfterSequenceValue,
            oryx_breakAfterTimeoutMs: breakAfterTimeoutMs,
            oryx_dataBits: dataBits,
            oryx_stopBits: stopBits,
            oryx_parity: parity,
            oryx_flowControl: flowControl,
            oryx_selectedPort: selectedPort,
            oryx_autoReconnect: autoReconnect,
            oryx_reconnectTimeoutSec: reconnectTimeoutSec,
        };
        for (const [key, value] of Object.entries(settings)) {
            localStorage.setItem(key, JSON.stringify(value));
        }
    }, [autoScroll, viewMode, showMacros, macroWidth, showTimestamp, showEol, maxLines, eolSequence, breakMode, breakAfterBytesCount, breakBeforeSequenceValue, breakAfterSequenceValue, breakAfterTimeoutMs, dataBits, stopBits, parity, flowControl, selectedPort, autoReconnect, reconnectTimeoutSec]);

    const value: SettingsContextType = {
        viewMode, setViewMode, theme, setTheme,
        autoScroll, setAutoScroll, showMacros, setShowMacros,
        macroWidth, setMacroWidth, showTimestamp, setShowTimestamp, showEol, setShowEol,
        maxLines, setMaxLines,
        eolSequence, setEolSequence, breakMode, setBreakMode,
        breakAfterBytesCount, setBreakAfterBytesCount,
        breakBeforeSequenceValue, setBreakBeforeSequenceValue,
        breakAfterSequenceValue, setBreakAfterSequenceValue,
        breakAfterTimeoutMs, setBreakAfterTimeoutMs,
        dataBits, setDataBits, stopBits, setStopBits,
        parity, setParity, flowControl, setFlowControl,
        selectedPort, setSelectedPort,
        logPath, setLogPath, isLogging, setIsLogging,
        autoReconnect, setAutoReconnect, reconnectTimeoutSec, setReconnectTimeoutSec,
    };

    return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}
