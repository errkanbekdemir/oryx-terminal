import { useEffect, useRef, useState, ReactNode } from 'react';
import { Command, Sun, Moon, Settings as SettingsIcon, Trash2, RefreshCw, FileText } from 'lucide-react';
import { Dropdown } from './Dropdown';
import { useSettings } from '../contexts/SettingsContext';
import { useModemLines } from '../hooks/useModemLines';

const FC_LABELS: Record<string, string> = {
    none: 'None',
    hardware: 'HW',
    software: 'SW',
    combined: 'HW+SW',
    manual_hardware: 'MAN HW',
    manual_software: 'MAN SW',
    manual_combined: 'MAN HW+SW',
    half_duplex: 'HALF-DUP',
    rs485: 'RS-485',
};

// Modes where RTS is driven by the driver or the mode logic — the manual toggle
// would fight it, so it's disabled
const RTS_OWNED_MODES = new Set(['hardware', 'combined', 'manual_hardware', 'manual_combined', 'half_duplex', 'rs485']);

// Interactive output (RTS/DTR): blue accent pill when driven high.
// Read-only input (CTS/DSR/DCD/RI): emerald glow dot when the line is high.
function ModemLed({ label, on, onClick, disabled, title }: {
    label: string;
    on: boolean;
    onClick?: () => void;
    disabled?: boolean;
    title: string;
}) {
    if (onClick) {
        return (
            <button
                onClick={onClick}
                disabled={disabled}
                title={title}
                className={`group/led flex items-center gap-1.5 px-2.5 py-[5px] rounded-full text-[9px] font-bold tracking-widest transition-all duration-300 ${disabled
                    ? 'opacity-35 cursor-not-allowed text-gray-400 dark:text-gray-600'
                    : on
                        ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400 ring-1 ring-inset ring-blue-500/30'
                        : 'text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-500/10 active:scale-95'
                    }`}
            >
                <span className={`w-1.5 h-1.5 rounded-full transition-all duration-300 ${on && !disabled
                    ? 'bg-blue-500 shadow-[0_0_6px_rgba(59,130,246,0.8)]'
                    : 'bg-gray-300 dark:bg-gray-600 group-hover/led:bg-gray-400 dark:group-hover/led:bg-gray-500'
                    }`} />
                {label}
            </button>
        );
    }
    return (
        <span
            title={title}
            className={`flex items-center gap-1.5 px-2 py-[5px] rounded-full text-[9px] font-bold tracking-widest cursor-default transition-colors duration-300 ${on
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-gray-400 dark:text-gray-600'
                }`}
        >
            <span className={`w-1.5 h-1.5 rounded-full transition-all duration-300 ${on
                ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.9)]'
                : 'bg-gray-300 dark:bg-gray-700'
                }`} />
            {label}
        </span>
    );
}

// Thin vertical separator between groups.
function Divider() {
    return <div className="h-4 w-px bg-gray-200 dark:bg-gray-800 flex-shrink-0" />;
}

// Measures the element's own rendered width (not the viewport) via
// ResizeObserver, so layout decisions are container-based rather than tied to
// a fixed screen breakpoint.
function useElementWidth<T extends HTMLElement>() {
    const ref = useRef<T>(null);
    const [width, setWidth] = useState(0);

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const observer = new ResizeObserver((entries) => {
            const entry = entries[0];
            if (entry) setWidth(entry.contentRect.width);
        });
        observer.observe(el);
        setWidth(el.getBoundingClientRect().width);
        return () => observer.disconnect();
    }, []);

    return [ref, width] as const;
}

interface StatusBarProps {
    isConnected: boolean;
    isReconnecting: boolean;
    reconnectElapsed: number;
    onOpenSettings: () => void;
    onClear: () => void;
    onOpenHelp: () => void;
}

export function StatusBar({
    isConnected,
    isReconnecting,
    reconnectElapsed,
    onOpenSettings,
    onClear,
    onOpenHelp,
}: StatusBarProps) {
    const {
        theme, setTheme, viewMode, setViewMode,
        autoScroll, setAutoScroll, showMacros, setShowMacros,
        selectedPort, dataBits, stopBits, parity, flowControl,
        reconnectTimeoutSec, isLogging, setIsLogging,
    } = useSettings();

    const { modemLines, rts, dtr, setRts, setDtr } = useModemLines(isConnected && !isReconnecting);
    const [containerRef, containerWidth] = useElementWidth<HTMLDivElement>();

    // True content-fit measurement instead of guessed pixel breakpoints: each
    // probe renders the real section content, invisibly and unwrapped, purely
    // to read its natural width. The left section (connection/UART/signals)
    // and right section (VIEW onward) are measured independently so a single
    // flexible gap can sit between them on one row, instead of distributing
    // space between every individual control.
    const [leftProbeRef, leftSectionWidth] = useElementWidth<HTMLDivElement>();
    const [rightProbeRef, rightSectionWidth] = useElementWidth<HTMLDivElement>();

    const getConfigShorthand = () => {
        const p = parity.toLowerCase().charAt(0).toUpperCase() || 'N';
        return `${dataBits}${p}${stopBits}`;
    };

    const fcMode = flowControl.toLowerCase();
    const getFlowControlLabel = () => FC_LABELS[fcMode] ?? 'None';
    const rtsOwned = RTS_OWNED_MODES.has(fcMode);

    // Minimum breathing room kept between the two sections on a single row —
    // this is the one flexible gap; it can shrink down to this floor before
    // anything wraps, but never disappears entirely.
    const MIN_SECTION_GAP = 16;

    // Before the first measurement (width === 0), assume wide so the bar
    // doesn't flash into a narrower layout on first paint.
    const notMeasuredYet = containerWidth === 0 || leftSectionWidth === 0 || rightSectionWidth === 0;
    const fitsWide = notMeasuredYet || containerWidth >= leftSectionWidth + rightSectionWidth + MIN_SECTION_GAP;
    const fitsMedium = notMeasuredYet || containerWidth >= Math.max(leftSectionWidth, rightSectionWidth);
    const layout: 'wide' | 'medium' | 'narrow' = fitsWide ? 'wide' : fitsMedium ? 'medium' : 'narrow';

    // ─── The eight logical groups, each an atomic unit for reflow ──────────

    const connectionGroup = (
        <div className={`flex items-center gap-2 px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border transition-all ${isReconnecting
            ? 'text-amber-700 dark:text-amber-400 bg-amber-500/10 border-amber-200 dark:border-amber-900/30'
            : isConnected
                ? 'text-green-700 dark:text-green-400 bg-green-500/10 border-green-200 dark:border-green-900/30'
                : 'text-gray-500 dark:text-gray-500 bg-gray-500/10 border-gray-200 dark:border-gray-800'
            }`}>
            {isReconnecting
                ? <RefreshCw size={10} className="animate-spin text-amber-500" />
                : <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-green-500 animate-pulse' : 'bg-gray-400'}`} />
            }
            <span className="truncate max-w-[160px]">
                {isReconnecting
                    ? `Reconnecting ${reconnectElapsed}s${reconnectTimeoutSec > 0 ? `/${reconnectTimeoutSec}s` : ''}...`
                    : isConnected ? selectedPort : 'Disconnected'
                }
            </span>
        </div>
    );

    const uartConfigGroup = (
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-blue-500/5 dark:bg-blue-500/10 border border-blue-200/50 dark:border-blue-900/20">
            <span className="text-[10px] font-bold text-blue-700 dark:text-blue-400 leading-none">
                {getConfigShorthand()}
            </span>
            <div className="w-px h-2 bg-blue-200 dark:bg-blue-800" />
            <span className="text-[10px] font-bold text-blue-600 dark:text-blue-500 leading-none flex items-center gap-1">
                <span className="opacity-50 font-normal">FC:</span> {getFlowControlLabel()}
            </span>
        </div>
    );

    const outputSignalsGroup = (
        <div className="flex items-center gap-px">
            <ModemLed
                label="RTS"
                on={rts && !rtsOwned}
                onClick={() => setRts(!rts)}
                disabled={rtsOwned}
                title={rtsOwned
                    ? `RTS is controlled by the ${getFlowControlLabel()} flow mode`
                    : `RTS: ${rts ? 'high' : 'low'} — click to toggle${isConnected ? '' : ' (applied on connect)'}`}
            />
            <ModemLed
                label="DTR"
                on={dtr}
                onClick={() => setDtr(!dtr)}
                title={`DTR: ${dtr ? 'high' : 'low'} — click to toggle${isConnected ? '' : ' (applied on connect)'}`}
            />
        </div>
    );

    const inputSignalsGroup = (
        <div className="flex items-center gap-px">
            <ModemLed
                label="CTS"
                on={!!modemLines?.cts}
                title={`CTS: ${modemLines ? (modemLines.cts ? 'high' : 'low') : 'unknown (no connection)'}`}
            />
            <ModemLed
                label="DSR"
                on={!!modemLines?.dsr}
                title={`DSR: ${modemLines ? (modemLines.dsr ? 'high' : 'low') : 'unknown (no connection)'}`}
            />
            <ModemLed
                label="DCD"
                on={!!modemLines?.cd}
                title={`DCD: ${modemLines ? (modemLines.cd ? 'high' : 'low') : 'unknown (no connection)'}`}
            />
            <ModemLed
                label="RI"
                on={!!modemLines?.ri}
                title={`RI: ${modemLines ? (modemLines.ri ? 'high' : 'low') : 'unknown (no connection)'}`}
            />
        </div>
    );

    const viewGroup = (
        <div className="flex items-center gap-1.5">
            <span className="text-[9px] font-bold text-gray-500 dark:text-gray-500 uppercase tracking-wide">View</span>
            <Dropdown
                value={viewMode}
                options={['text', 'char', 'hex', 'dec', 'oct', 'bin'].map(m => ({ label: m.toUpperCase(), value: m }))}
                onChange={setViewMode}
                direction="up"
                size="sm"
                minWidth="70px"
            />
        </div>
    );

    const autoGroup = (
        <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-bold transition-all hover:bg-gray-100 dark:hover:bg-white/5 ${autoScroll
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-gray-400 dark:text-gray-600'
                }`}
            title="Auto-scroll"
        >
            {autoScroll ? 'AUTO ON' : 'AUTO OFF'}
        </button>
    );

    const toolsGroup = (
        <div className="flex items-center gap-2">
            <button
                onClick={() => setIsLogging(!isLogging)}
                className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-bold transition-all hover:bg-gray-100 dark:hover:bg-white/5 ${isLogging
                    ? 'text-red-600 dark:text-red-400 bg-red-500/5 animate-pulse-slow'
                    : 'text-gray-500 dark:text-gray-400'
                    }`}
                title={isLogging ? 'Stop Logging' : 'Start Logging'}
            >
                <FileText size={10} />
                {isLogging ? 'LOGGING' : 'LOG'}
            </button>

            <button
                onClick={() => setShowMacros(!showMacros)}
                className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-bold transition-all hover:bg-gray-100 dark:hover:bg-white/5 ${showMacros
                    ? 'text-blue-600 dark:text-blue-400 bg-blue-500/5'
                    : 'text-gray-500 dark:text-gray-400'
                    }`}
                title="Toggle Macros"
            >
                <Command size={10} />
                MACROS
            </button>
        </div>
    );

    const utilityGroup = (
        <div className="flex items-center gap-1">
            <button
                onClick={onClear}
                className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-white/5 text-gray-500 dark:text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-all active:scale-90"
                title="Clear Terminal (Ctrl+L)"
            >
                <Trash2 size={14} />
            </button>

            <button
                onClick={onOpenSettings}
                className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-white/5 text-gray-500 dark:text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 transition-all active:scale-90"
                title="Settings"
            >
                <SettingsIcon size={14} />
            </button>

            <button
                onClick={onOpenHelp}
                className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-white/5 text-gray-500 dark:text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 transition-all active:scale-90 font-bold text-xs w-6 h-6 flex items-center justify-center"
                title="Keyboard Shortcuts (?)"
            >
                ?
            </button>

            <button
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-white/5 text-gray-500 dark:text-gray-400 hover:text-amber-500 dark:hover:text-amber-400 transition-all hover:rotate-12 active:rotate-45 duration-300"
                title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            >
                {theme === 'dark' ? <Moon size={14} className="transition-all duration-300 rotate-12" /> : <Sun size={14} className="transition-all duration-300 -rotate-12" />}
            </button>
        </div>
    );

    // ─── The two primary sections, each internally packed with fixed gaps ──
    // (uniform spacing, no internal stretch) — the only flexible space in the
    // whole bar lives between these two, never between individual controls.

    const leftSectionGroup = (
        <div className="flex items-center gap-3">
            {connectionGroup}
            <Divider />
            {uartConfigGroup}
            <Divider />
            {outputSignalsGroup}
            <Divider />
            {inputSignalsGroup}
        </div>
    );

    const rightSectionGroup = (
        <div className="flex items-center gap-3">
            {viewGroup}
            <Divider />
            {autoGroup}
            <Divider />
            {toolsGroup}
            <Divider />
            {utilityGroup}
        </div>
    );

    // ─── Row assembly — exact group membership per row, no ad-hoc wrapping ──

    const rowClass = 'flex items-center h-9 flex-shrink-0';

    let rows: ReactNode[];
    if (layout === 'wide') {
        // The one flexible gap in the whole bar: justify-between spaces
        // exactly these two atomic sections apart, with each section's own
        // internal spacing staying fixed (gap-3 above), never stretched.
        rows = [
            <div key="row1" className={`${rowClass} justify-between`}>
                {leftSectionGroup}
                {rightSectionGroup}
            </div>,
        ];
    } else if (layout === 'medium') {
        rows = [
            <div key="row1" className={`${rowClass} gap-3`}>{leftSectionGroup}</div>,
            <div key="row2" className={`${rowClass} gap-3`}>
                {viewGroup}
                <Divider />
                {autoGroup}
                <Divider />
                {toolsGroup}
                <div className="ml-auto flex items-center gap-3">
                    <Divider />
                    {utilityGroup}
                </div>
            </div>,
        ];
    } else {
        rows = [
            <div key="row1" className={`${rowClass} gap-3`}>
                {connectionGroup}
                <Divider />
                {uartConfigGroup}
            </div>,
            <div key="row2" className={`${rowClass} gap-3`}>
                {outputSignalsGroup}
                <Divider />
                {inputSignalsGroup}
            </div>,
            <div key="row3" className={`${rowClass} gap-3`}>
                {viewGroup}
                <Divider />
                {autoGroup}
                <Divider />
                {toolsGroup}
                <div className="ml-auto flex items-center gap-3">
                    <Divider />
                    {utilityGroup}
                </div>
            </div>,
        ];
    }

    // Same content as the real sections, rendered unwrapped and invisibly
    // purely to read each section's natural (unconstrained) width — the
    // actual "would this fit as one row" test, measured directly rather than
    // guessed.
    const probeClass = 'absolute invisible pointer-events-none top-0 left-0 whitespace-nowrap';

    return (
        <div
            ref={containerRef}
            className="relative flex flex-col px-4 py-1 bg-white dark:bg-[#1a1c20] border-t border-gray-200 dark:border-[#303339] text-gray-600 dark:text-gray-400 select-none z-30 transition-colors duration-200"
        >
            <div ref={leftProbeRef} className={probeClass} aria-hidden="true">{leftSectionGroup}</div>
            <div ref={rightProbeRef} className={probeClass} aria-hidden="true">{rightSectionGroup}</div>

            {rows}
        </div>
    );
}
