import { useEffect, useRef, useState, useMemo, memo } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import clsx from 'clsx';
import { Copy, Trash, MousePointer2, Binary, Scissors, Send } from 'lucide-react';
import { parseInput } from '../utils/parser';
import { parseAnsi } from '../utils/ansiParser';
import { ContextMenu } from './ContextMenu';

export interface LogEntry {
    id: string;
    timestamp: string;
    type: 'rx' | 'tx' | 'system' | 'error';
    text: string;
    originalData?: number[];
}

interface TerminalProps {
    lines: LogEntry[];
    autoScroll: boolean;
    setAutoScroll: (auto: boolean) => void;
    showTimestamp: boolean;
    setShowTimestamp: (show: boolean) => void;
    viewMode: 'text' | 'hex' | 'bin' | 'dec' | 'oct' | 'char';
    showEol: boolean;
    eolSequence: string;
    onClear: () => void;
    hasSeenAnsi: boolean;
    onSendCommand?: (command: string) => Promise<boolean>;
}

function formatByte(b: number, mode: string): string {
    switch (mode) {
        case 'hex':  return b.toString(16).padStart(2, '0').toUpperCase();
        case 'bin':  return b.toString(2).padStart(8, '0');
        case 'dec':  return b.toString(10).padStart(3, '0');
        case 'oct':  return b.toString(8).padStart(3, '0');
        case 'char': return (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.';
        default:     return '';
    }
}

const formatData = (data: number[], mode: string): string =>
    data.map(b => formatByte(b, mode)).join(' ');

// ─── Byte Inspector ──────────────────────────────────────────────────────────

interface ByteInspectorConfig {
    endian: 'le' | 'be' | 'both';
    types: {
        uint8: boolean; int8: boolean;
        uint16: boolean; int16: boolean;
        uint32: boolean; int32: boolean;
        float32: boolean;
    };
}

const DEFAULT_INSPECTOR_CONFIG: ByteInspectorConfig = {
    endian: 'both',
    types: { uint8: true, int8: false, uint16: true, int16: false, uint32: true, int32: false, float32: false },
};

function loadInspectorConfig(): ByteInspectorConfig {
    try {
        return JSON.parse(localStorage.getItem('oryx_byteInspector') || 'null') ?? DEFAULT_INSPECTOR_CONFIG;
    } catch { return DEFAULT_INSPECTOR_CONFIG; }
}

function dv(data: number[], i: number, len: number): DataView {
    const buf = new ArrayBuffer(len);
    new Uint8Array(buf).set(data.slice(i, i + len));
    return new DataView(buf);
}

function fmtFloat(v: number): string {
    if (!isFinite(v)) return v.toString();
    // Show up to 6 significant digits, strip trailing zeros
    return parseFloat(v.toPrecision(6)).toString();
}

function ByteTooltip({ data, idx, x, y, onClose }: { data: number[]; idx: number; x: number; y: number; onClose?: () => void; }) {
    const [config, setConfig] = useState<ByteInspectorConfig>(loadInspectorConfig);

    const updateConfig = (next: ByteInspectorConfig) => {
        setConfig(next);
        localStorage.setItem('oryx_byteInspector', JSON.stringify(next));
    };

    const toggleEndian = (e: 'le' | 'be' | 'both') => updateConfig({ ...config, endian: e });
    const toggleType = (t: keyof ByteInspectorConfig['types']) =>
        updateConfig({ ...config, types: { ...config.types, [t]: !config.types[t] } });

    const b = data[idx];
    const has2 = idx + 1 < data.length;
    const has4 = idx + 3 < data.length;
    const showLE = config.endian === 'le' || config.endian === 'both';
    const showBE = config.endian === 'be' || config.endian === 'both';
    const showBoth = config.endian === 'both';

    const char = b >= 32 && b <= 126 ? String.fromCharCode(b) : '·';

    // Flip left if near right edge
    const tipWidth = 320;
    const leftPos = x + 14 + tipWidth > window.innerWidth ? x - tipWidth - 4 : x + 14;

    const typeKeys: (keyof ByteInspectorConfig['types'])[] = ['uint8', 'int8', 'uint16', 'int16', 'uint32', 'int32', 'float32'];
    const typeLabels: Record<keyof ByteInspectorConfig['types'], string> = {
        uint8: 'u8', int8: 'i8', uint16: 'u16', int16: 'i16', uint32: 'u32', int32: 'i32', float32: 'f32',
    };

    return (
        <>
        <div className="fixed inset-0 z-[199]" onClick={onClose} />
        <div
            className="fixed z-[200] bg-[#18181b] border border-white/10 rounded-lg shadow-2xl text-[11px] font-mono overflow-hidden"
            style={{ left: leftPos, top: y - 8, width: tipWidth }}
        >
            {/* Config header */}
            <div className="px-2 py-1.5 border-b border-white/10 flex flex-col gap-1">
                {/* Endianness */}
                <div className="flex items-center gap-1">
                    <span className="text-gray-500 text-[9px] uppercase font-bold mr-1">Endian</span>
                    {(['le', 'both', 'be'] as const).map(e => (
                        <button key={e} onClick={() => toggleEndian(e)}
                            className={clsx("px-1.5 py-0.5 rounded text-[9px] uppercase font-bold transition-colors",
                                config.endian === e ? "bg-blue-600 text-white" : "text-gray-400 hover:text-gray-200"
                            )}>
                            {e === 'both' ? 'Both' : e.toUpperCase()}
                        </button>
                    ))}
                </div>
                {/* Type toggles */}
                <div className="flex items-center gap-1 flex-wrap">
                    <span className="text-gray-500 text-[9px] uppercase font-bold mr-1">Types</span>
                    {typeKeys.map(t => (
                        <button key={t} onClick={() => toggleType(t)}
                            className={clsx("px-1.5 py-0.5 rounded text-[9px] uppercase font-bold transition-colors",
                                config.types[t] ? "bg-blue-600 text-white" : "text-gray-600 hover:text-gray-400"
                            )}>
                            {typeLabels[t]}
                        </button>
                    ))}
                </div>
            </div>

            {/* Always-shown: single byte formats */}
            <div className="px-2.5 py-1.5 border-b border-white/10 grid grid-cols-3 gap-x-4 gap-y-0.5">
                <Row label="IDX"  value={idx} />
                <Row label="HEX"  value={b.toString(16).padStart(2, '0').toUpperCase()} />
                <Row label="DEC"  value={b.toString(10)} />
                <Row label="BIN"  value={b.toString(2).padStart(8, '0')} />
                <Row label="OCT"  value={b.toString(8).padStart(3, '0')} />
                <Row label="CHAR" value={char} />
            </div>

            {/* Typed interpretations */}
            <div className="px-2.5 py-1.5 grid grid-cols-1 gap-y-0.5">
                {config.types.uint8 && <EndianRow label="uint8" showLE={true} showBE={false} showBoth={false} le={b} be={0} />}
                {config.types.int8  && <EndianRow label="int8"  showLE={true} showBE={false} showBoth={false} le={new DataView(new Uint8Array([b]).buffer).getInt8(0)} be={0} />}

                {config.types.uint16 && has2 && (
                    <EndianRow label="uint16" showLE={showLE} showBE={showBE} showBoth={showBoth}
                        le={dv(data, idx, 2).getUint16(0, true)} be={dv(data, idx, 2).getUint16(0, false)} />
                )}
                {config.types.int16 && has2 && (
                    <EndianRow label="int16"  showLE={showLE} showBE={showBE} showBoth={showBoth}
                        le={dv(data, idx, 2).getInt16(0, true)} be={dv(data, idx, 2).getInt16(0, false)} />
                )}
                {config.types.uint32 && has4 && (
                    <EndianRow label="uint32" showLE={showLE} showBE={showBE} showBoth={showBoth}
                        le={dv(data, idx, 4).getUint32(0, true)} be={dv(data, idx, 4).getUint32(0, false)} />
                )}
                {config.types.int32 && has4 && (
                    <EndianRow label="int32"  showLE={showLE} showBE={showBE} showBoth={showBoth}
                        le={dv(data, idx, 4).getInt32(0, true)} be={dv(data, idx, 4).getInt32(0, false)} />
                )}
                {config.types.float32 && has4 && (
                    <EndianRow label="float32" showLE={showLE} showBE={showBE} showBoth={showBoth}
                        le={fmtFloat(dv(data, idx, 4).getFloat32(0, true))}
                        be={fmtFloat(dv(data, idx, 4).getFloat32(0, false))} />
                )}
            </div>
        </div>
        </>
    );
}

function Row({ label, value }: { label: string; value: string | number }) {
    return (
        <div className="flex items-center gap-2">
            <span className="text-gray-500 text-[9px] uppercase font-bold tracking-wider">{label}</span>
            <span className="text-gray-200">{String(value)}</span>
        </div>
    );
}

function EndianRow({ label, showLE, showBE, showBoth, le, be }: {
    label: string; showLE: boolean; showBE: boolean; showBoth: boolean;
    le: string | number; be: string | number;
}) {
    return (
        <div className="flex items-baseline gap-2">
            <span className="text-gray-500 text-[9px] uppercase font-bold tracking-wider w-14 flex-shrink-0">{label}</span>
            {showLE && (
                <span className="text-gray-200">
                    {showBoth && <span className="text-gray-500 text-[9px] mr-1">LE</span>}
                    {String(le)}
                </span>
            )}
            {showBE && (
                <span className="text-gray-200">
                    {showBoth && <span className="text-gray-500 text-[9px] mr-1">BE</span>}
                    {String(be)}
                </span>
            )}
        </div>
    );
}

// ─── Memoized Row Component ──────────────────────────────────────────────────

interface TerminalRowProps {
    line: LogEntry;
    viewMode: string;
    showTimestamp: boolean;
    showEol: boolean;
    eolBytes: number[];
    hasSeenAnsi: boolean;
    inspectorEnabled: boolean;
    autoScroll: boolean;
    onToggleAutoScroll: () => void;
    onToggleTimestamp: () => void;
    onToggleInspector: () => void;
    onClear: () => void;
    onSendCommand: (command: string) => void;
}

const TerminalRow = memo(function TerminalRow({
    line,
    viewMode,
    showTimestamp,
    showEol,
    eolBytes,
    hasSeenAnsi,
    inspectorEnabled,
    autoScroll,
    onToggleAutoScroll,
    onToggleTimestamp,
    onToggleInspector,
    onClear,
    onSendCommand,
}: TerminalRowProps) {
    const [selectedByteIdx, setSelectedByteIdx] = useState<number | null>(null);
    const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
    const [contextMenu, setContextMenu] = useState<{ x: number, y: number } | null>(null);

    const isNonTextMode = viewMode !== 'text' && !!line.originalData && line.originalData.length > 0;
    const isByteMode = inspectorEnabled && isNonTextMode; // interactive per-byte spans

    let content = line.text;
    if (isNonTextMode) {
        content = formatData(line.originalData!, viewMode);
    }

    const lineHasAnsi = /\x1b\[[\d;]*m/.test(line.text);
    const isRx = line.type === 'rx';
    const isTx = line.type === 'tx';

    // Compute EOL match once per row
    let hasEolMatch = false;
    if (showEol && line.originalData && eolBytes.length > 0) {
        const data = line.originalData;
        if (data.length >= eolBytes.length) {
            hasEolMatch = true;
            for (let i = 0; i < eolBytes.length; i++) {
                if (data[data.length - eolBytes.length + i] !== eolBytes[i]) {
                    hasEolMatch = false;
                    break;
                }
            }
        }
    }

    const handleRowContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({ x: e.clientX, y: e.clientY });
    };

    const copyLine = () => {
        navigator.clipboard.writeText(line.text);
    };

    const copyLineWithTimestamp = () => {
        navigator.clipboard.writeText(`${line.timestamp} ${line.text}`);
    };

    const copyLineAsHex = () => {
        if (line.originalData) {
            navigator.clipboard.writeText(formatData(line.originalData, 'hex'));
        }
    };

    return (
        <>
        <div
            onContextMenu={handleRowContextMenu}
            className={clsx("px-0 py-0.5 leading-tight break-all flex border-b border-gray-100 dark:border-white/5 hover:bg-gray-50 dark:hover:bg-white/5 group", {
            // SIMPLE MODE (Green/Blue)
            "text-green-600 dark:text-green-400": isRx && !hasSeenAnsi && !lineHasAnsi,
            "text-blue-600 dark:text-blue-400": isTx && !hasSeenAnsi && !lineHasAnsi,
            // ANSI MODE (Neutral/Purple)
            "text-purple-700 dark:text-purple-300": isTx && (hasSeenAnsi || lineHasAnsi),
            // System/Error always distinct
            "text-gray-600 dark:text-gray-400": line.type === 'system',
            "text-red-600 dark:text-red-400": line.type === 'error',
        })}>
            {/* Metadata Gutter (Timestamp + Direction) */}
            <div className="flex items-center gap-2 px-2 bg-gray-50/5 dark:bg-white/[0.01] border-r border-gray-100 dark:border-white/5 select-none flex-shrink-0">
                {showTimestamp && (
                    <span className="text-gray-600 dark:text-white text-xs w-[95px] flex-shrink-0 font-mono tracking-tight text-right pr-1 border-r border-gray-200/50 dark:border-white/10 mr-1 opacity-80">
                        {line.timestamp}
                    </span>
                )}

                <span className={clsx("w-4 flex-shrink-0 font-bold text-center text-xs", {
                    "text-blue-500": line.type === 'tx',
                    "text-green-500": line.type === 'rx',
                    "opacity-0": line.type === 'system' || line.type === 'error'
                })}>
                    {line.type === 'tx' ? '→' : line.type === 'rx' ? '←' : ''}
                </span>
            </div>

            <span className="flex-grow whitespace-pre-wrap font-medium font-mono relative px-3 py-0.5">
                {isNonTextMode ? (
                    isByteMode ? (
                        line.originalData!.map((byte, bIdx) => (
                            <span key={bIdx}>
                                <span
                                    onClick={(e) => { e.stopPropagation(); setSelectedByteIdx(selectedByteIdx === bIdx ? null : bIdx); setTooltipPos({ x: e.clientX, y: e.clientY }); }}
                                    className={clsx(
                                        "rounded px-0.5 transition-colors cursor-pointer select-none",
                                        selectedByteIdx !== null && bIdx === selectedByteIdx     && "bg-blue-500/30 text-blue-200",
                                        selectedByteIdx !== null && bIdx === selectedByteIdx + 1 && "bg-blue-500/15",
                                        selectedByteIdx !== null && (bIdx === selectedByteIdx + 2 || bIdx === selectedByteIdx + 3) && "bg-blue-500/10",
                                    )}
                                >
                                    {formatByte(byte, viewMode)}
                                </span>
                                {bIdx < line.originalData!.length - 1 && ' '}
                            </span>
                        ))
                    ) : (
                        content
                    )
                ) : (
                    content.includes('\x1b') ? (
                        parseAnsi(content).map((segment, idx) => (
                            <span
                                key={idx}
                                style={segment.style}
                                className={clsx({
                                    "font-bold": segment.bold,
                                    "underline": segment.underline
                                })}
                            >
                                {segment.text}
                            </span>
                        ))
                    ) : (
                        content
                    )
                )}
                {hasEolMatch && (
                    <span className="inline-flex items-center ml-1 text-blue-500/50 dark:text-blue-400/30 select-none font-bold" title="EOL">
                        ↵
                    </span>
                )}
            </span>

            {/* Copy button - visible on hover */}
            <div className="flex-shrink-0 px-2 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
                <button
                    onClick={(e) => { e.stopPropagation(); copyLine(); }}
                    className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-white/10 transition-colors"
                    title="Copy line"
                >
                    <Copy size={14} />
                </button>
                <button
                    onClick={(e) => { e.stopPropagation(); onSendCommand(line.text); }}
                    className="p-1 rounded text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-200 dark:hover:bg-white/10 transition-colors"
                    title="Send as command"
                >
                    <Send size={12} />
                </button>
            </div>

            {selectedByteIdx !== null && line.originalData && (
                <ByteTooltip data={line.originalData} idx={selectedByteIdx} x={tooltipPos.x} y={tooltipPos.y} onClose={() => setSelectedByteIdx(null)} />
            )}
        </div>

        {contextMenu && (
            <ContextMenu
                x={contextMenu.x}
                y={contextMenu.y}
                onClose={() => setContextMenu(null)}
                options={[
                    { label: 'Copy Line', icon: Copy, onClick: copyLine },
                    { label: 'Copy with Timestamp', icon: Copy, onClick: copyLineWithTimestamp },
                    line.originalData && { label: 'Copy as Hex', icon: Scissors, onClick: copyLineAsHex },
                    { separator: true },
                    { label: autoScroll ? 'Disable Auto-Scroll' : 'Enable Auto-Scroll', icon: MousePointer2, onClick: onToggleAutoScroll },
                    { label: showTimestamp ? 'Hide Timestamp' : 'Show Timestamp', icon: MousePointer2, onClick: onToggleTimestamp },
                    { label: inspectorEnabled ? 'Disable Byte Inspector' : 'Enable Byte Inspector', icon: Binary, onClick: onToggleInspector },
                    { separator: true },
                    { label: 'Clear Terminal', icon: Trash, onClick: onClear, variant: 'danger' },
                ].filter((opt: any) => opt !== undefined && opt !== true && (opt.separator || opt.label))}
            />
        )}
        </>
    );
});

// ─── Terminal Component ──────────────────────────────────────────────────────

export function Terminal({
    lines,
    autoScroll,
    setAutoScroll,
    showTimestamp,
    setShowTimestamp,
    viewMode,
    showEol,
    eolSequence,
    onClear,
    hasSeenAnsi,
    onSendCommand,
}: TerminalProps) {
    const virtuosoRef = useRef<VirtuosoHandle>(null);
    const [contextMenu, setContextMenu] = useState<{ x: number, y: number } | null>(null);
    const [inspectorEnabled, setInspectorEnabled] = useState<boolean>(() => {
        const saved = localStorage.getItem('oryx_byteInspectorEnabled');
        return saved === null ? true : saved === 'true';
    });

    // Memoize EOL bytes — computed once when eolSequence changes, not per-line
    const eolBytes = useMemo(() => {
        try {
            return parseInput(eolSequence);
        } catch {
            return [];
        }
    }, [eolSequence]);

    // Force scroll to bottom when lines change if autoScroll is enabled
    useEffect(() => {
        if (autoScroll && virtuosoRef.current) {
            virtuosoRef.current.scrollToIndex({
                index: lines.length - 1,
                align: 'end',
                behavior: 'auto'
            });
        }
    }, [lines.length, autoScroll]);

    const handleContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY });
    };

    const handleCopy = () => {
        const selected = window.getSelection()?.toString();
        if (selected) {
            navigator.clipboard.writeText(selected);
        }
    };

    return (
        <div
            className="flex-grow font-mono text-sm overflow-hidden h-full relative bg-white dark:bg-[#1e1e1e] text-gray-950 dark:text-gray-100 transition-colors duration-200"
            onContextMenu={handleContextMenu}
        >
            <Virtuoso
                ref={virtuosoRef}
                data={lines}
                totalCount={lines.length}
                followOutput={autoScroll ? "auto" : false}
                initialTopMostItemIndex={lines.length - 1}
                itemContent={(_, line) => (
                    <TerminalRow
                        line={line}
                        viewMode={viewMode}
                        showTimestamp={showTimestamp}
                        showEol={showEol}
                        eolBytes={eolBytes}
                        hasSeenAnsi={hasSeenAnsi}
                        inspectorEnabled={inspectorEnabled}
                        autoScroll={autoScroll}
                        onToggleAutoScroll={() => setAutoScroll(!autoScroll)}
                        onToggleTimestamp={() => setShowTimestamp(!showTimestamp)}
                        onToggleInspector={() => {
                            const next = !inspectorEnabled;
                            setInspectorEnabled(next);
                            localStorage.setItem('oryx_byteInspectorEnabled', String(next));
                        }}
                        onClear={onClear}
                        onSendCommand={(cmd) => onSendCommand?.(cmd)}
                    />
                )}
                style={{ height: '100%' }}
            />

            {contextMenu && (
                <ContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    onClose={() => setContextMenu(null)}
                    options={[
                        { label: 'Copy Selected', icon: Copy, onClick: handleCopy },
                        { label: 'Clear Terminal', icon: Trash, onClick: onClear, variant: 'danger' },
                        {
                            label: autoScroll ? 'Disable Auto-Scroll' : 'Enable Auto-Scroll',
                            icon: MousePointer2,
                            onClick: () => setAutoScroll(!autoScroll)
                        },
                        {
                            label: showTimestamp ? 'Hide Timestamp' : 'Show Timestamp',
                            icon: MousePointer2,
                            onClick: () => setShowTimestamp(!showTimestamp)
                        },
                        {
                            label: inspectorEnabled ? 'Disable Byte Inspector' : 'Enable Byte Inspector',
                            icon: Binary,
                            onClick: () => {
                                const next = !inspectorEnabled;
                                setInspectorEnabled(next);
                                localStorage.setItem('oryx_byteInspectorEnabled', String(next));
                            }
                        },
                    ]}
                />
            )}
        </div>
    );
}
