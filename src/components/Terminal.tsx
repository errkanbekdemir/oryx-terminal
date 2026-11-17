import { useCallback, useEffect, useRef, useState, useMemo, memo } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import clsx from 'clsx';
import { Copy, Trash, MousePointer2, Binary, Scissors, Send, X, Clock, Search } from 'lucide-react';
import { parseInput } from '../utils/parser';
import { parseAnsi, AnsiState, DEFAULT_ANSI_STATE, isDefaultAnsiState } from '../utils/ansiParser';
import { ContextMenu } from './ContextMenu';
import { TerminalSearchBar, makeSearchRegex, findRanges, highlightText, layerRanges, MATCH_CLASS, ACTIVE_MATCH_CLASS } from './TerminalSearch';
import { useTauriEvent } from '../hooks/useTauriEvent';

export interface LogEntry {
    id: string;
    timestamp: string;
    type: 'rx' | 'tx' | 'system' | 'error';
    text: string;
    originalData?: number[];
    /** SGR state carried over from the previous line, so a color set once
     *  and never reset keeps applying to later plain lines instead of
     *  silently reverting to default. */
    ansiStart?: AnsiState;
}

interface TerminalProps {
    lines: LogEntry[];
    /** Cumulative count of lines trimmed off the front (Virtuoso firstItemIndex) */
    firstItemIndex: number;
    autoScroll: boolean;
    setAutoScroll: (auto: boolean) => void;
    showTimestamp: boolean;
    setShowTimestamp: (show: boolean) => void;
    viewMode: 'text' | 'hex' | 'bin' | 'dec' | 'oct' | 'char';
    showEol: boolean;
    eolSequence: string;
    onClear: () => void;
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

/** A position in a row's displayed text (see displayText) */
interface TextPoint { id: string; offset: number }

/** Exactly the characters a row shows — selection offsets index into this. */
function displayText(line: LogEntry, viewMode: string): string {
    return viewMode !== 'text' && line.originalData && line.originalData.length > 0
        ? formatData(line.originalData, viewMode)
        : line.text.replace(/\x1b\[[\d;]*m/g, ''); // same sequences parseAnsi consumes
}

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
    inspectorEnabled: boolean;
    autoScroll: boolean;
    isSelected: boolean;
    selectedCount: number;
    /** Last selection made by the user's own left-button drag/click — excludes
     *  the word-under-cursor auto-selection some browsers perform when a
     *  right-click opens a context menu over unselected text. */
    confirmedSelectionRef: React.RefObject<string>;
    selectionTsRef: React.RefObject<string>;
    onSelectLine: (id: string, mods: { ctrl: boolean; shift: boolean }) => void;
    onCopySelected: (withTimestamps: boolean) => void;
    onToggleAutoScroll: () => void;
    onToggleTimestamp: () => void;
    onToggleInspector: () => void;
    onClear: () => void;
    onSendCommand: (command: string) => void;
    onFind: () => void;
    searchRe: RegExp | null;
    isActiveMatch: boolean;
    /** Text-selection range within this row's displayed text; -1 = none */
    selStart: number;
    selEnd: number;
}

const TerminalRow = memo(function TerminalRow({
    line,
    viewMode,
    showTimestamp,
    showEol,
    eolBytes,
    inspectorEnabled,
    autoScroll,
    isSelected,
    selectedCount,
    confirmedSelectionRef,
    selectionTsRef,
    onSelectLine,
    onCopySelected,
    onToggleAutoScroll,
    onToggleTimestamp,
    onToggleInspector,
    onClear,
    onSendCommand,
    onFind,
    searchRe,
    isActiveMatch,
    selStart,
    selEnd,
}: TerminalRowProps) {
    const [selectedByteIdx, setSelectedByteIdx] = useState<number | null>(null);
    const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
    const [contextMenu, setContextMenu] = useState<{ x: number, y: number } | null>(null);
    // Snapshot of the confirmed selection at the moment of right-click
    const [nativeSelection, setNativeSelection] = useState('');
    const [nativeSelectionTs, setNativeSelectionTs] = useState('');

    const isNonTextMode = viewMode !== 'text' && !!line.originalData && line.originalData.length > 0;
    const isByteMode = inspectorEnabled && isNonTextMode; // interactive per-byte spans

    let content = line.text;
    if (isNonTextMode) {
        content = formatData(line.originalData!, viewMode);
    }

    // line.text is always the UTF-8 decode of the raw bytes, even in
    // Hex/Bin/Dec/Oct/Char view — so binary payloads can coincidentally
    // decode into something matching an ANSI CSI sequence. ANSI is a
    // text-view concept only; ignore it entirely outside Text view so
    // arbitrary binary data can't flip the line's color.
    const lineHasAnsi = !isNonTextMode && /\x1b\[[\d;]*m/.test(line.text);
    const ansiStart = line.ansiStart ?? DEFAULT_ANSI_STATE;
    // A line with no codes of its own still needs ANSI-aware rendering if an
    // earlier line left a color/style active — otherwise it wrongly snaps
    // back to the default look mid-stream even though nothing reset it.
    const usesAnsiStyling = !isNonTextMode && (lineHasAnsi || !isDefaultAnsiState(ansiStart));
    const isRx = line.type === 'rx';
    const isTx = line.type === 'tx';

    // Search highlighting runs on exactly what this row renders, so the
    // marked ranges line up whatever the view mode or ANSI styling.
    const markClass = isActiveMatch ? ACTIVE_MATCH_CLASS : MATCH_CLASS;
    const ansiSegments = usesAnsiStyling ? parseAnsi(content, ansiStart).segments : null;
    const searchRanges = searchRe
        ? findRanges(ansiSegments ? ansiSegments.map(s => s.text).join('') : content, searchRe)
        : [];
    const marks = layerRanges(searchRanges, markClass, selStart, selEnd);

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
        setNativeSelection(confirmedSelectionRef.current);
        setNativeSelectionTs(selectionTsRef.current);
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
            data-line-id={line.id}
            onContextMenu={handleRowContextMenu}
            className={clsx("px-0 py-0.5 leading-tight break-all flex border-b border-gray-100 dark:border-white/5 hover:bg-gray-50 dark:hover:bg-white/5 group", {
            // SIMPLE MODE (Green/Blue)
            "text-green-600 dark:text-green-400": isRx && !usesAnsiStyling,
            "text-blue-600 dark:text-blue-400": isTx && !usesAnsiStyling,
            // ANSI MODE (Neutral/Purple)
            "text-purple-700 dark:text-purple-300": isTx && usesAnsiStyling,
            // System/Error always distinct
            "text-gray-600 dark:text-gray-400": line.type === 'system',
            "text-red-600 dark:text-red-400": line.type === 'error',
            // Line selection highlight
            "bg-blue-500/10 dark:bg-blue-500/15": isSelected,
        })}>
            {/* Metadata Gutter (Timestamp + Direction) — click to select the line */}
            <div
                data-gutter
                onClick={(e) => onSelectLine(line.id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })}
                title="Click to select · Shift+Click range · Ctrl+Click toggle"
                className={clsx(
                    "flex items-center gap-2 px-2 bg-gray-50/5 dark:bg-white/[0.01] border-r select-none flex-shrink-0 cursor-pointer",
                    isSelected
                        ? "border-l-2 border-l-blue-500 border-r-gray-100 dark:border-r-white/5"
                        : "border-l-2 border-l-transparent border-r-gray-100 dark:border-r-white/5"
                )}
            >
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

            <span data-line-text className="flex-grow whitespace-pre-wrap font-medium font-mono relative px-3 py-0.5">
                {isNonTextMode ? (
                    isByteMode ? (
                        (() => {
                            let pos = 0; // offset of each byte within `content` ("XX XX ...")
                            return line.originalData!.map((byte, bIdx) => {
                                const label = formatByte(byte, viewMode);
                                const start = pos;
                                pos += label.length + 1;
                                const mark = marks.find(([s, e]) => s < start + label.length && e > start)?.[2];
                                return (
                                    <span key={bIdx}>
                                        <span
                                            onClick={(e) => { e.stopPropagation(); setSelectedByteIdx(selectedByteIdx === bIdx ? null : bIdx); setTooltipPos({ x: e.clientX, y: e.clientY }); }}
                                            className={clsx(
                                                "rounded px-0.5 transition-colors cursor-pointer select-none",
                                                mark,
                                                selectedByteIdx !== null && bIdx === selectedByteIdx     && "bg-blue-500/30 text-blue-200",
                                                selectedByteIdx !== null && bIdx === selectedByteIdx + 1 && "bg-blue-500/15",
                                                selectedByteIdx !== null && (bIdx === selectedByteIdx + 2 || bIdx === selectedByteIdx + 3) && "bg-blue-500/10",
                                            )}
                                        >
                                            {label}
                                        </span>
                                        {bIdx < line.originalData!.length - 1 && ' '}
                                    </span>
                                );
                            });
                        })()
                    ) : (
                        highlightText(content, marks, 0)
                    )
                ) : (
                    ansiSegments ? (
                        (() => {
                            let offset = 0;
                            return ansiSegments.map((segment, idx) => {
                                const segOffset = offset;
                                offset += segment.text.length;
                                return (
                                    <span
                                        key={idx}
                                        style={segment.style}
                                        className={clsx({
                                            "font-bold": segment.bold,
                                            "underline": segment.underline
                                        })}
                                    >
                                        {highlightText(segment.text, marks, segOffset)}
                                    </span>
                                );
                            });
                        })()
                    ) : (
                        highlightText(content, marks, 0)
                    )
                )}
                {hasEolMatch && (
                    <span data-no-text className="inline-flex items-center ml-1 text-blue-500/50 dark:text-blue-400/30 select-none font-bold" title="EOL">
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
                    ...(nativeSelection ? [
                        { label: 'Copy Text Selection', icon: Copy, onClick: () => navigator.clipboard.writeText(nativeSelection) },
                        ...(nativeSelectionTs ? [{ label: 'Copy Text Selection with Timestamps', icon: Clock, onClick: () => navigator.clipboard.writeText(nativeSelectionTs) }] : []),
                    ] as const : []),
                    { label: 'Copy Line', icon: Copy, onClick: copyLine },
                    { label: 'Copy with Timestamp', icon: Copy, onClick: copyLineWithTimestamp },
                    ...(line.originalData ? [{ label: 'Copy as Hex', icon: Scissors, onClick: copyLineAsHex }] as const : []),
                    ...(selectedCount > 0 ? [
                        { label: `Copy Selected (${selectedCount})`, icon: Copy, onClick: () => onCopySelected(false) },
                        { label: `Copy Selected with Timestamps`, icon: Copy, onClick: () => onCopySelected(true) },
                    ] as const : []),
                    { separator: true },
                    { label: 'Find… (Ctrl+F)', icon: Search, onClick: onFind },
                    { label: autoScroll ? 'Disable Auto-Scroll' : 'Enable Auto-Scroll', icon: MousePointer2, onClick: onToggleAutoScroll },
                    { label: showTimestamp ? 'Hide Timestamp' : 'Show Timestamp', icon: MousePointer2, onClick: onToggleTimestamp },
                    { label: inspectorEnabled ? 'Disable Byte Inspector' : 'Enable Byte Inspector', icon: Binary, onClick: onToggleInspector },
                    { separator: true },
                    { label: 'Clear Terminal', icon: Trash, onClick: onClear, variant: 'danger' },
                ]}
            />
        )}
        </>
    );
});

// ─── Terminal Component ──────────────────────────────────────────────────────

export function Terminal({
    lines,
    firstItemIndex,
    autoScroll,
    setAutoScroll,
    showTimestamp,
    setShowTimestamp,
    viewMode,
    showEol,
    eolSequence,
    onClear,
    onSendCommand,
}: TerminalProps) {
    const virtuosoRef = useRef<VirtuosoHandle>(null);
    const [contextMenu, setContextMenu] = useState<{ x: number, y: number } | null>(null);
    const [inspectorEnabled, setInspectorEnabled] = useState<boolean>(() => {
        const saved = localStorage.getItem('oryx_byteInspectorEnabled');
        return saved === null ? true : saved === 'true';
    });

    // ─── Search ──────────────────────────────────────────────────────────────
    const [searchOpen, setSearchOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [debouncedQuery, setDebouncedQuery] = useState('');
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [filterOnly, setFilterOnly] = useState(false);
    const [activeMatchId, setActiveMatchId] = useState<string | null>(null);
    const [jumpTick, setJumpTick] = useState(0);
    const searchInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const t = setTimeout(() => setDebouncedQuery(query), 150);
        return () => clearTimeout(t);
    }, [query]);

    const searchRe = useMemo(
        () => (searchOpen ? makeSearchRegex(debouncedQuery, caseSensitive) : null),
        [searchOpen, debouncedQuery, caseSensitive],
    );

    // Per-entry match cache: entries are immutable (an open line that grows is
    // replaced by a new object), so only newly arrived lines get tested.
    const matchCache = useMemo(() => new WeakMap<LogEntry, boolean>(), [searchRe, viewMode]); // eslint-disable-line react-hooks/exhaustive-deps
    const matchedLines = useMemo(() => {
        if (!searchRe) return [];
        return lines.filter(l => {
            let hit = matchCache.get(l);
            if (hit === undefined) {
                const text = viewMode !== 'text' && l.originalData && l.originalData.length > 0
                    ? formatData(l.originalData, viewMode)
                    : l.text.replace(/\x1b\[[\d;]*[A-Za-z]/g, '');
                searchRe.lastIndex = 0;
                hit = searchRe.test(text);
                matchCache.set(l, hit);
            }
            return hit;
        });
    }, [lines, searchRe, matchCache, viewMode]);

    const filterActive = filterOnly && searchRe !== null;
    const viewLines = filterActive ? matchedLines : lines;
    const viewFirst = filterActive ? 0 : firstItemIndex;

    // ─── Line selection (keyed by stable line id — survives trimming) ────────
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const anchorIdRef = useRef<string | null>(null);

    // Refs so the selection callback stays referentially stable (keeps row memo effective)
    const linesRef = useRef(lines);
    linesRef.current = lines;
    const viewLinesRef = useRef(viewLines);
    viewLinesRef.current = viewLines;

    // id → index in the displayed list, built on demand (range select, drag,
    // search jump) — rebuilding it for every incoming line is wasted work
    // with a large display limit.
    const viewIndexCache = useRef<{ lines: LogEntry[]; map: Map<string, number> } | null>(null);
    const getViewIndex = useCallback(() => {
        const cur = viewLinesRef.current;
        if (viewIndexCache.current?.lines !== cur) {
            const map = new Map<string, number>();
            cur.forEach((l, i) => map.set(l.id, i));
            viewIndexCache.current = { lines: cur, map };
        }
        return viewIndexCache.current.map;
    }, []);
    const viewModeRef = useRef(viewMode);
    viewModeRef.current = viewMode;

    // ─── Search navigation ───────────────────────────────────────────────────
    const matchedLinesRef = useRef(matchedLines);
    matchedLinesRef.current = matchedLines;
    const activeMatchIdRef = useRef(activeMatchId);
    activeMatchIdRef.current = activeMatchId;

    const jumpTo = useCallback((id: string) => {
        setActiveMatchId(id);
        setJumpTick(t => t + 1);
        // Otherwise the next incoming line yanks the view back to the bottom
        setAutoScroll(false);
    }, [setAutoScroll]);

    // dir -1 = older (up), +1 = newer (down); starts from the newest match
    const stepMatch = useCallback((dir: -1 | 1) => {
        const matches = matchedLinesRef.current;
        if (matches.length === 0) return;
        const pos = matches.findIndex(l => l.id === activeMatchIdRef.current);
        const next = pos === -1 ? matches.length - 1 : (pos + dir + matches.length) % matches.length;
        jumpTo(matches[next].id);
    }, [jumpTo]);

    // A new query jumps to the newest match
    useEffect(() => {
        const matches = matchedLinesRef.current;
        if (searchRe && matches.length > 0) jumpTo(matches[matches.length - 1].id);
        else setActiveMatchId(null);
    }, [searchRe]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        const id = activeMatchIdRef.current;
        if (!id) return;
        const idx = getViewIndex().get(id);
        if (idx !== undefined) {
            virtuosoRef.current?.scrollToIndex({ index: viewFirst + idx, align: 'center', behavior: 'auto' });
        }
    }, [jumpTick]); // eslint-disable-line react-hooks/exhaustive-deps

    // Toggling the filter remounts the list at the bottom — bring the active match back
    useEffect(() => {
        if (activeMatchIdRef.current) setJumpTick(t => t + 1);
    }, [filterActive]);

    const openSearch = useCallback(() => {
        setSearchOpen(true);
        // Focus after the bar mounts; select so typing replaces the last query
        requestAnimationFrame(() => { searchInputRef.current?.focus(); searchInputRef.current?.select(); });
    }, []);

    const closeSearch = useCallback(() => {
        setSearchOpen(false);
        setActiveMatchId(null);
    }, []);

    const searchOpenRef = useRef(searchOpen);
    searchOpenRef.current = searchOpen;

    // macOS menu (⌘F / ⌘G / ⇧⌘G) — see mac_menu in src-tauri/src/lib.rs
    useTauriEvent<string>('menu-find', (action) => {
        if (action === 'find' || !searchOpenRef.current) openSearch();
        else stepMatch(action === 'find-next' ? -1 : 1);
    });

    const activePos = activeMatchId ? matchedLines.findIndex(l => l.id === activeMatchId) + 1 : 0;

    const handleSelectLine = useCallback((id: string, mods: { ctrl: boolean; shift: boolean }) => {
        setSelectedIds(prev => {
            const curLines = viewLinesRef.current;
            const next = new Set(prev);
            const anchor = anchorIdRef.current;
            const a = mods.shift && anchor !== null ? getViewIndex().get(anchor) : undefined;
            const b = a !== undefined ? getViewIndex().get(id) : undefined;
            if (a !== undefined && b !== undefined) {
                const [lo, hi] = a <= b ? [a, b] : [b, a];
                if (!mods.ctrl) next.clear();
                for (let i = lo; i <= hi; i++) next.add(curLines[i].id);
            } else if (mods.ctrl) {
                if (next.has(id)) next.delete(id); else next.add(id);
                anchorIdRef.current = id;
            } else {
                next.clear();
                next.add(id);
                anchorIdRef.current = id;
            }
            return next;
        });
    }, [getViewIndex]);

    // Prune ids whose lines were trimmed or cleared so the count stays honest
    useEffect(() => {
        setSelectedIds(prev => {
            if (prev.size === 0) return prev;
            const alive = lines.filter(l => prev.has(l.id));
            return alive.length === prev.size ? prev : new Set(alive.map(l => l.id));
        });
    }, [lines]);

    const selectedIdsRef = useRef(selectedIds);
    selectedIdsRef.current = selectedIds;

    // ─── Confirmed native text selection ──────────────────────────────────────
    // Chromium auto-selects the word under the cursor when a right-click opens
    // a context menu over otherwise-unselected text. Left unguarded, that makes
    // "Copy Text Selection" appear on every right-click even without an
    // intentional drag/click selection. Track selection changes but only
    // record ones made with the left button; a right-button mousedown always
    // collapses the previous selection to '' though, so that signal still
    // comes through.
    const confirmedSelectionRef = useRef('');
    /** The same selection with each line's timestamp prefixed */
    const selectionTsRef = useRef('');
    const mouseButtonRef = useRef(0);
    useEffect(() => {
        const onMouseDown = (e: MouseEvent) => { mouseButtonRef.current = e.button; };
        const onSelectionChange = () => {
            const text = window.getSelection()?.toString() ?? '';
            if (text === '' || mouseButtonRef.current !== 2) {
                confirmedSelectionRef.current = text;
                const rowId = (window.getSelection()?.anchorNode?.parentElement?.closest('[data-line-id]') as HTMLElement | null)?.dataset.lineId;
                const idx = text && rowId ? getViewIndex().get(rowId) : undefined;
                selectionTsRef.current = idx !== undefined ? `${viewLinesRef.current[idx].timestamp} ${text}` : '';
            }
        };
        document.addEventListener('mousedown', onMouseDown, true);
        document.addEventListener('selectionchange', onSelectionChange);
        return () => {
            document.removeEventListener('mousedown', onMouseDown, true);
            document.removeEventListener('selectionchange', onSelectionChange);
        };
    }, []);

    // Copy from the lines data (not the DOM) so off-screen virtualized rows are included
    const selectedText = useCallback((withTimestamps: boolean) => {
        const ids = selectedIdsRef.current;
        if (ids.size === 0) return '';
        const mode = viewModeRef.current;
        return linesRef.current
            .filter(l => ids.has(l.id))
            .map(l => {
                const body = mode !== 'text' && l.originalData && l.originalData.length > 0
                    ? formatData(l.originalData, mode)
                    : l.text;
                return withTimestamps ? `${l.timestamp} ${body}` : body;
            })
            .join('\n');
    }, []);

    const copySelected = useCallback((withTimestamps = false) => {
        const text = selectedText(withTimestamps);
        if (text) navigator.clipboard.writeText(text);
    }, [selectedText]);

    // ─── Drag selection ──────────────────────────────────────────────────────
    // Native text selection lives in the DOM, and virtualized rows unmount as
    // they scroll away — so a drag that scrolls loses its start. Once a drag
    // leaves the row it began in, the selection is kept in data instead: by
    // character (line id + offset into the row's displayed text) when it
    // starts in the text, by whole lines when it starts in the gutter.
    // Selection inside a single row stays native.
    const containerRef = useRef<HTMLDivElement>(null);
    const [dragSelecting, setDragSelecting] = useState(false);
    const [textSel, setTextSel] = useState<{ anchor: TextPoint; focus: TextPoint } | null>(null);
    const setAutoScrollRef = useRef(setAutoScroll);
    setAutoScrollRef.current = setAutoScroll;

    const selBounds = useMemo(() => {
        if (!textSel) return null;
        const map = getViewIndex();
        const a = map.get(textSel.anchor.id);
        const f = map.get(textSel.focus.id);
        if (a === undefined || f === undefined) return null; // an end was trimmed/filtered away
        const forward = a < f || (a === f && textSel.anchor.offset <= textSel.focus.offset);
        const [start, end] = forward ? [textSel.anchor, textSel.focus] : [textSel.focus, textSel.anchor];
        return { startIdx: Math.min(a, f), startOff: start.offset, endIdx: Math.max(a, f), endOff: end.offset };
    }, [textSel, viewLines, getViewIndex]); // eslint-disable-line react-hooks/exhaustive-deps
    const selBoundsRef = useRef(selBounds);
    selBoundsRef.current = selBounds;

    const textSelectionString = useCallback((withTimestamps = false) => {
        const b = selBoundsRef.current;
        if (!b) return '';
        const cur = viewLinesRef.current;
        const out: string[] = [];
        for (let i = b.startIdx; i <= b.endIdx && i < cur.length; i++) {
            const t = displayText(cur[i], viewModeRef.current);
            const slice = t.slice(i === b.startIdx ? b.startOff : 0, i === b.endIdx ? b.endOff : t.length);
            out.push((withTimestamps ? `${cur[i].timestamp} ` : '') + slice.replace(/[\r\n]+$/, ''));
        }
        return out.join('\n');
    }, []);

    // Feeds "Copy Text Selection" in the context menus, like a native selection would
    useEffect(() => {
        if (dragSelecting) return;
        confirmedSelectionRef.current = selBounds ? textSelectionString() : '';
        selectionTsRef.current = selBounds ? textSelectionString(true) : '';
    }, [selBounds, dragSelecting, textSelectionString]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        let drag: {
            kind: 'text' | 'lines'; anchor: TextPoint; base: Set<string> | null;
            active: boolean; x: number; y: number; last: string; raf: number;
        } | null = null;

        // Row and character under a point; points outside the list clamp to its edge rows
        const pointAt = (x: number, y: number): TextPoint | null => {
            const r = el.getBoundingClientRect();
            const cx = Math.min(Math.max(x, r.left + 1), r.right - 1);
            const cy = Math.min(Math.max(y, r.top + 1), r.bottom - 1);
            const row = document.elementFromPoint(cx, cy)?.closest('[data-line-id]') as HTMLElement | null;
            const id = row?.dataset.lineId;
            if (!row || !id) return null;
            const textEl = row.querySelector('[data-line-text]');
            if (!textEl) return { id, offset: 0 };
            const extra = textEl.querySelector('[data-no-text]')?.textContent?.length ?? 0;
            const len = (textEl.textContent?.length ?? 0) - extra;
            if (y < r.top || cx < textEl.getBoundingClientRect().left) return { id, offset: 0 };
            if (y > r.bottom) return { id, offset: len };
            const caret = document.caretRangeFromPoint?.(cx, cy);
            if (!caret || !textEl.contains(caret.startContainer)) return { id, offset: len };
            const pre = document.createRange();
            pre.selectNodeContents(textEl);
            pre.setEnd(caret.startContainer, caret.startOffset);
            return { id, offset: Math.min(pre.toString().length, len) };
        };

        const frame = () => {
            const d = drag;
            if (!d) return;
            d.raf = requestAnimationFrame(frame);
            const r = el.getBoundingClientRect();
            const p = pointAt(d.x, d.y);
            if (!d.active) {
                const left = d.y < r.top || d.y > r.bottom;
                if (!left && (!p || p.id === d.anchor.id)) return;
                d.active = true;
                setDragSelecting(true);
                if (d.kind === 'text') setSelectedIds(prev => (prev.size > 0 ? new Set<string>() : prev));
            }
            const EDGE = 28;
            if (d.y < r.top + EDGE) {
                // Otherwise incoming data keeps pulling the view back down
                setAutoScrollRef.current(false);
                virtuosoRef.current?.scrollBy({ top: -Math.min(60, 8 + (r.top + EDGE - d.y) / 2) });
            } else if (d.y > r.bottom - EDGE) {
                virtuosoRef.current?.scrollBy({ top: Math.min(60, 8 + (d.y - (r.bottom - EDGE)) / 2) });
            }
            if (!p) return;
            const key = d.kind === 'text' ? `${p.id}:${p.offset}` : p.id;
            if (key === d.last) return;
            d.last = key;
            window.getSelection()?.removeAllRanges();
            if (d.kind === 'text') {
                setTextSel({ anchor: d.anchor, focus: p });
                return;
            }
            const map = getViewIndex();
            const cur = viewLinesRef.current;
            const a = map.get(d.anchor.id);
            const b = map.get(p.id);
            if (a === undefined || b === undefined) return;
            const [lo, hi] = a <= b ? [a, b] : [b, a];
            const next = new Set(d.base ?? []);
            for (let i = lo; i <= hi; i++) next.add(cur[i].id);
            setSelectedIds(next);
        };

        const end = () => {
            if (!drag) return;
            cancelAnimationFrame(drag.raf);
            if (drag.active) {
                if (drag.kind === 'lines') anchorIdRef.current = drag.anchor.id; // Shift+Click can extend from here
                setDragSelecting(false);
            }
            drag = null;
        };

        const onDown = (e: MouseEvent) => {
            if (e.button !== 0 || e.shiftKey) return;
            const target = e.target as HTMLElement;
            if (target.closest('input, button')) return;
            setTextSel(null);
            if (!target.closest('[data-line-id]')) return;
            const anchor = pointAt(e.clientX, e.clientY);
            if (!anchor) return;
            drag = {
                kind: target.closest('[data-gutter]') ? 'lines' : 'text',
                anchor, active: false, x: e.clientX, y: e.clientY, last: '', raf: 0,
                base: e.ctrlKey || e.metaKey ? new Set(selectedIdsRef.current) : null,
            };
            drag.raf = requestAnimationFrame(frame);
        };
        const onMove = (e: MouseEvent) => { if (drag) { drag.x = e.clientX; drag.y = e.clientY; } };

        el.addEventListener('mousedown', onDown);
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', end);
        window.addEventListener('blur', end);
        return () => {
            end();
            el.removeEventListener('mousedown', onDown);
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', end);
            window.removeEventListener('blur', end);
        };
    }, [getViewIndex]);

    // ⌘C on macOS goes through the Edit menu's native copy, which arrives
    // here as a `copy` event rather than a keydown — serve selected lines
    // when there is no native text selection to copy.
    useEffect(() => {
        const onCopy = (e: ClipboardEvent) => {
            const target = e.target as HTMLElement | null;
            if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
            if (window.getSelection()?.toString()) return;
            const text = textSelectionString() || selectedText(false);
            if (!text || !e.clipboardData) return;
            e.clipboardData.setData('text/plain', text);
            e.preventDefault();
        };
        document.addEventListener('copy', onCopy);
        return () => document.removeEventListener('copy', onCopy);
    }, [selectedText, textSelectionString]);

    // Keyboard: Ctrl+C copies selected lines (native text selection wins),
    // Ctrl+Shift+C always copies selected lines, Escape clears the selection
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            // Search keys work from anywhere, including the sender input
            if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
                e.preventDefault();
                openSearch();
                return;
            }
            if (e.key === 'F3' && searchOpenRef.current) {
                e.preventDefault();
                stepMatch(e.shiftKey ? 1 : -1);
                return;
            }
            const target = e.target as HTMLElement;
            if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
            if (e.key === 'Escape') {
                setTextSel(null);
                setSelectedIds(prev => prev.size > 0 ? new Set<string>() : prev);
                return;
            }
            if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'c') {
                if (!e.shiftKey && selBoundsRef.current && !window.getSelection()?.toString()) {
                    e.preventDefault();
                    navigator.clipboard.writeText(textSelectionString());
                    return;
                }
                if (e.shiftKey) {
                    if (selectedIdsRef.current.size > 0) {
                        e.preventDefault();
                        copySelected(false);
                    }
                } else {
                    const native = confirmedSelectionRef.current;
                    if (!native && selectedIdsRef.current.size > 0) {
                        e.preventDefault();
                        copySelected(false);
                    }
                }
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [copySelected, openSearch, stepMatch, textSelectionString]);

    // Memoize EOL bytes — computed once when eolSequence changes, not per-line
    const eolBytes = useMemo(() => {
        try {
            return parseInput(eolSequence);
        } catch {
            return [];
        }
    }, [eolSequence]);

    // Force scroll to bottom when new lines arrive if autoScroll is enabled.
    // Depends on total-ever-appended (firstItemIndex + length), not length alone:
    // once the display cap is reached, length stays constant while trimming —
    // the old length-based dependency stopped firing and auto-scroll died.
    const totalAppended = firstItemIndex + lines.length;
    useEffect(() => {
        if (autoScroll && virtuosoRef.current && viewLines.length > 0) {
            virtuosoRef.current.scrollToIndex({
                index: viewFirst + viewLines.length - 1,
                align: 'end',
                behavior: 'auto'
            });
        }
    }, [totalAppended, autoScroll, filterActive]); // eslint-disable-line react-hooks/exhaustive-deps

    const handleContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY });
    };

    // Copies the confirmed native browser text selection (visible rows only)
    const handleCopy = () => {
        const selected = confirmedSelectionRef.current;
        if (selected) {
            navigator.clipboard.writeText(selected);
        }
    };

    return (
        <div
            ref={containerRef}
            className={clsx(
                "flex-grow font-mono text-sm overflow-hidden h-full relative bg-white dark:bg-[#1e1e1e] text-gray-950 dark:text-gray-100 transition-colors duration-200",
                dragSelecting && "select-none",
            )}
            onContextMenu={handleContextMenu}
        >
            {searchOpen && (
                <TerminalSearchBar
                    inputRef={searchInputRef}
                    query={query}
                    onQueryChange={setQuery}
                    caseSensitive={caseSensitive}
                    onToggleCase={() => setCaseSensitive(c => !c)}
                    filterOnly={filterOnly}
                    onToggleFilter={() => setFilterOnly(f => !f)}
                    current={activePos}
                    total={matchedLines.length}
                    onOlder={() => stepMatch(-1)}
                    onNewer={() => stepMatch(1)}
                    onClose={closeSearch}
                />
            )}

            <Virtuoso
                // Remount when switching between all lines and the filtered
                // subset — they don't share an index space (firstItemIndex)
                key={filterActive ? 'filtered' : 'all'}
                ref={virtuosoRef}
                data={viewLines}
                totalCount={viewLines.length}
                firstItemIndex={viewFirst}
                followOutput={autoScroll ? "auto" : false}
                initialTopMostItemIndex={Math.max(0, viewFirst + viewLines.length - 1)}
                // Keep far more rows mounted above/below the viewport than Virtuoso's tiny
                // default overscan. Native browser text selection dies the instant its DOM
                // node unmounts, so this buys a much larger scroll range before an in-progress
                // selection is destroyed. It's a mitigation, not a guarantee — for a selection
                // that must survive arbitrary scrolling, use gutter-click line selection instead.
                increaseViewportBy={{ top: 4000, bottom: 4000 }}
                itemContent={(index, line) => {
                    const i = index - viewFirst;
                    const inSel = selBounds !== null && i >= selBounds.startIdx && i <= selBounds.endIdx;
                    return (
                    <TerminalRow
                        line={line}
                        viewMode={viewMode}
                        showTimestamp={showTimestamp}
                        showEol={showEol}
                        eolBytes={eolBytes}
                        inspectorEnabled={inspectorEnabled}
                        autoScroll={autoScroll}
                        isSelected={selectedIds.has(line.id)}
                        selectedCount={selectedIds.size}
                        confirmedSelectionRef={confirmedSelectionRef}
                        selectionTsRef={selectionTsRef}
                        onSelectLine={handleSelectLine}
                        onCopySelected={copySelected}
                        onToggleAutoScroll={() => setAutoScroll(!autoScroll)}
                        onToggleTimestamp={() => setShowTimestamp(!showTimestamp)}
                        onToggleInspector={() => {
                            const next = !inspectorEnabled;
                            setInspectorEnabled(next);
                            localStorage.setItem('oryx_byteInspectorEnabled', String(next));
                        }}
                        onClear={onClear}
                        onSendCommand={(cmd) => onSendCommand?.(cmd)}
                        onFind={openSearch}
                        searchRe={searchRe}
                        isActiveMatch={searchRe !== null && line.id === activeMatchId}
                        selStart={inSel ? (i === selBounds.startIdx ? selBounds.startOff : 0) : -1}
                        selEnd={inSel ? (i === selBounds.endIdx ? selBounds.endOff : Number.MAX_SAFE_INTEGER) : -1}
                    />
                    );
                }}
                style={{ height: '100%' }}
            />

            {/* Floating copy affordance — visible whenever lines are selected */}
            {selectedIds.size > 0 && (
                <div className="absolute bottom-3 right-3 z-[50] flex items-center gap-0.5 bg-white/95 dark:bg-[#2b2d31]/95 backdrop-blur-sm border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg px-1.5 py-1">
                    <button
                        onClick={() => copySelected(false)}
                        className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-bold text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded transition-colors"
                        title="Copy selected lines (Ctrl+C / Ctrl+Shift+C)"
                    >
                        <Copy size={12} />
                        Copy Selected ({selectedIds.size})
                    </button>
                    <button
                        onClick={() => copySelected(true)}
                        className="p-1.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded transition-colors"
                        title="Copy selected lines with timestamps"
                    >
                        <Clock size={12} />
                    </button>
                    <div className="w-px h-3.5 bg-gray-200 dark:bg-gray-700 mx-0.5" />
                    <button
                        onClick={() => setSelectedIds(new Set())}
                        className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded transition-colors"
                        title="Clear selection (Esc)"
                    >
                        <X size={12} />
                    </button>
                </div>
            )}

            {contextMenu && (
                <ContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    onClose={() => setContextMenu(null)}
                    options={[
                        ...(selectedIds.size > 0 ? [
                            { label: `Copy Selected (${selectedIds.size})`, icon: Copy, onClick: () => copySelected(false) },
                            { label: 'Copy Selected with Timestamps', icon: Copy, onClick: () => copySelected(true) },
                        ] as const : []),
                        ...(confirmedSelectionRef.current ? [
                            { label: 'Copy Text Selection', icon: Copy, onClick: handleCopy },
                            ...(selectionTsRef.current ? [{ label: 'Copy Text Selection with Timestamps', icon: Clock, onClick: () => navigator.clipboard.writeText(selectionTsRef.current) }] : []),
                        ] as const : []),
                        { label: 'Find… (Ctrl+F)', icon: Search, onClick: openSearch },
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
