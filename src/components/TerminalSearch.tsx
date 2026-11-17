import { ReactNode, RefObject } from 'react';
import { Virtuoso } from 'react-virtuoso';
import clsx from 'clsx';
import { Search, CaseSensitive, ListFilter, ChevronUp, ChevronDown, X, Regex, PanelBottom, Copy, Save } from 'lucide-react';

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export type SearchDirection = 'all' | 'rx' | 'tx';

/** Literal search by default, the user's own pattern with `regex`. The `i`
 *  flag keeps match offsets aligned with the original text, unlike
 *  lowercasing both sides (e.g. Turkish İ). */
export function compileSearch(query: string, caseSensitive: boolean, regex: boolean): { re: RegExp | null; error: string | null } {
    if (!query) return { re: null, error: null };
    try {
        return { re: new RegExp(regex ? query : escapeRegExp(query), caseSensitive ? 'g' : 'gi'), error: null };
    } catch (e) {
        return { re: null, error: (e as Error).message };
    }
}

/** Non-empty matches only — a pattern like `a*` matches the empty string
 *  everywhere. The line's trailing CR/LF is left out so `$` means end of line. */
export function findRanges(text: string, re: RegExp): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (const m of text.replace(/[\r\n]+$/, '').matchAll(re)) if (m[0].length > 0) out.push([m.index, m.index + m[0].length]);
    return out;
}

/** [start, end, className] — sorted, non-overlapping */
export type StyledRange = [number, number, string];

/** Search matches plus the text selection (which wins where they overlap).
 *  `selStart < 0` means no selection in this row. */
export function layerRanges(search: Array<[number, number]>, markClass: string, selStart: number, selEnd: number): StyledRange[] {
    const hasSel = selStart >= 0 && selEnd > selStart;
    const out: StyledRange[] = [];
    for (const [s, e] of search) {
        if (!hasSel || e <= selStart || s >= selEnd) { out.push([s, e, markClass]); continue; }
        if (s < selStart) out.push([s, selStart, markClass]);
        if (e > selEnd) out.push([selEnd, e, markClass]);
    }
    if (hasSel) out.push([selStart, selEnd, SELECTION_CLASS]);
    return out.sort((a, b) => a[0] - b[0]);
}

/** Render `text` (which sits at `offset` within the row's full text) with
 *  the parts covered by `ranges` wrapped in <mark>. */
export function highlightText(text: string, ranges: StyledRange[], offset: number): ReactNode {
    const end = offset + text.length;
    const out: ReactNode[] = [];
    let pos = offset;
    for (const [s, e, markClass] of ranges) {
        if (e <= pos || s >= end) continue;
        const a = Math.max(s, pos);
        const b = Math.min(e, end);
        if (a > pos) out.push(text.slice(pos - offset, a - offset));
        out.push(<mark key={a} className={markClass}>{text.slice(a - offset, b - offset)}</mark>);
        pos = b;
    }
    if (out.length === 0) return text;
    if (pos < end) out.push(text.slice(pos - offset));
    return out;
}

export const MATCH_CLASS = 'bg-yellow-300/70 dark:bg-yellow-400/35 text-inherit rounded-sm';
export const SELECTION_CLASS = 'bg-blue-500/35 dark:bg-blue-400/40 text-inherit';
export const ACTIVE_MATCH_CLASS ='bg-orange-400/90 dark:bg-orange-500/70 text-inherit rounded-sm';

interface TerminalSearchBarProps {
    inputRef: RefObject<HTMLInputElement | null>;
    query: string;
    onQueryChange: (q: string) => void;
    caseSensitive: boolean;
    onToggleCase: () => void;
    regex: boolean;
    onToggleRegex: () => void;
    /** Message for an invalid regular expression */
    error: string | null;
    filterOnly: boolean;
    onToggleFilter: () => void;
    resultsOpen: boolean;
    onToggleResults: () => void;
    /** 1-based position of the active match, 0 if none */
    current: number;
    total: number;
    onOlder: () => void;
    onNewer: () => void;
    onClose: () => void;
}

export function TerminalSearchBar({
    inputRef, query, onQueryChange, caseSensitive, onToggleCase, regex, onToggleRegex, error,
    filterOnly, onToggleFilter, resultsOpen, onToggleResults,
    current, total, onOlder, onNewer, onClose,
}: TerminalSearchBarProps) {
    const toggleClass = (on: boolean) => clsx(
        'p-1 rounded transition-colors',
        on ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400' : 'text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10',
    );
    const navClass = 'p-1 rounded text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-white/10 disabled:opacity-30 transition-colors';

    return (
        <div
            className="absolute top-2 right-4 z-[60] flex items-center gap-1 bg-white/95 dark:bg-[#2b2d31]/95 backdrop-blur-sm border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg pl-2 pr-1 py-1 font-sans"
            onContextMenu={(e) => e.stopPropagation()}
        >
            <Search size={13} className="text-gray-400 flex-shrink-0" />
            <input
                ref={inputRef}
                value={query}
                onChange={(e) => onQueryChange(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) onNewer(); else onOlder(); }
                    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
                }}
                placeholder="Search output…"
                spellCheck={false}
                className="w-44 bg-transparent text-xs font-mono text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none py-0.5"
            />
            <span
                className={clsx('text-[10px] font-mono tabular-nums min-w-[52px] text-right pr-1', query && total === 0 ? 'text-red-500' : 'text-gray-500 dark:text-gray-400')}
                title={error ?? undefined}
            >
                {error ? 'Bad regex' : query ? (total === 0 ? 'No results' : `${current}/${total}`) : ''}
            </span>
            <button onClick={onToggleCase} className={toggleClass(caseSensitive)} title="Match case">
                <CaseSensitive size={14} />
            </button>
            <button onClick={onToggleRegex} className={toggleClass(regex)} title="Regular expression">
                <Regex size={13} />
            </button>
            <button onClick={onToggleFilter} className={toggleClass(filterOnly)} title="Show only matching lines">
                <ListFilter size={13} />
            </button>
            <button onClick={onToggleResults} className={toggleClass(resultsOpen)} title="List all results (Ctrl/⌘+Shift+F)">
                <PanelBottom size={13} />
            </button>
            <div className="w-px h-3.5 bg-gray-200 dark:bg-gray-700 mx-0.5" />
            <button onClick={onOlder} disabled={total === 0} className={navClass} title="Older match (Enter / F3)">
                <ChevronUp size={14} />
            </button>
            <button onClick={onNewer} disabled={total === 0} className={navClass} title="Newer match (Shift+Enter / Shift+F3)">
                <ChevronDown size={14} />
            </button>
            <button onClick={onClose} className={navClass} title="Close (Esc)">
                <X size={13} />
            </button>
        </div>
    );
}

// ─── Results panel ───────────────────────────────────────────────────────────

interface ResultLine { id: string; timestamp: string; type: 'rx' | 'tx' | 'system' | 'error' }

interface SearchResultsPanelProps<T extends ResultLine> {
    lines: T[];
    /** Total occurrences across `lines` */
    matchCount: number;
    searchRe: RegExp | null;
    /** The text the search ran on, for one line */
    getText: (line: T) => string;
    activeId: string | null;
    onJump: (id: string) => void;
    direction: SearchDirection;
    onDirectionChange: (d: SearchDirection) => void;
    onCopy: () => void;
    onSave: () => void;
    onClose: () => void;
}

const SNIPPET_LEAD = 40;   // context kept before the first match of a long line
const SNIPPET_MAX = 600;

function ResultRow<T extends ResultLine>({ line, re, text, active, onJump }: { line: T; re: RegExp; text: string; active: boolean; onJump: (id: string) => void }) {
    let ranges = findRanges(text, re);
    let shown = text.replace(/[\r\n]+$/, '');
    // Bring a match that sits far to the right into view
    const cut = ranges.length > 0 && ranges[0][0] > SNIPPET_LEAD * 2 ? ranges[0][0] - SNIPPET_LEAD : 0;
    if (cut > 0) {
        shown = '…' + shown.slice(cut);
        ranges = ranges.map(([s, e]) => [s - cut + 1, e - cut + 1]);
    }
    shown = shown.slice(0, SNIPPET_MAX);
    return (
        <div
            onClick={() => onJump(line.id)}
            title="Jump to this line"
            className={clsx(
                'flex items-baseline gap-2 px-3 py-0.5 cursor-pointer border-l-2 text-xs font-mono',
                active ? 'bg-orange-500/10 border-l-orange-500' : 'border-l-transparent hover:bg-gray-100 dark:hover:bg-white/5',
            )}
        >
            <span className="text-gray-500 dark:text-gray-400 flex-shrink-0 tabular-nums">{line.timestamp}</span>
            <span className={clsx('flex-shrink-0 w-3 font-bold', line.type === 'tx' ? 'text-blue-500' : line.type === 'rx' ? 'text-green-500' : 'text-gray-400')}>
                {line.type === 'tx' ? '→' : line.type === 'rx' ? '←' : '·'}
            </span>
            <span className={clsx('truncate whitespace-pre', {
                'text-green-700 dark:text-green-400': line.type === 'rx',
                'text-blue-700 dark:text-blue-400': line.type === 'tx',
                'text-gray-600 dark:text-gray-400': line.type === 'system',
                'text-red-600 dark:text-red-400': line.type === 'error',
            })}>
                {highlightText(shown, ranges.map(([s, e]): StyledRange => [s, e, MATCH_CLASS]), 0)}
            </span>
        </div>
    );
}

export function SearchResultsPanel<T extends ResultLine>({
    lines, matchCount, searchRe, getText, activeId, onJump, direction, onDirectionChange, onCopy, onSave, onClose,
}: SearchResultsPanelProps<T>) {
    const btn = 'p-1 rounded text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100 hover:bg-gray-200 dark:hover:bg-white/10 disabled:opacity-30 transition-colors';
    return (
        <div className="flex-shrink-0 h-[38%] min-h-[140px] flex flex-col border-t border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-[#18191c] font-sans">
            <div className="flex items-center gap-2 px-3 py-1 border-b border-gray-200 dark:border-gray-800 flex-shrink-0">
                <span className="text-[11px] font-bold text-gray-700 dark:text-gray-200">
                    {searchRe
                        ? `${lines.length} line${lines.length === 1 ? '' : 's'} · ${matchCount} match${matchCount === 1 ? '' : 'es'}`
                        : 'Type in the search box to list results'}
                </span>
                <div className="flex items-center rounded-md bg-gray-200/70 dark:bg-white/5 p-0.5 ml-2">
                    {(['all', 'rx', 'tx'] as const).map(d => (
                        <button
                            key={d}
                            onClick={() => onDirectionChange(d)}
                            className={clsx(
                                'px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide transition-all',
                                direction === d
                                    ? 'bg-white dark:bg-[#2b2d31] text-blue-600 dark:text-blue-400 shadow-sm'
                                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200',
                            )}
                        >
                            {d}
                        </button>
                    ))}
                </div>
                <div className="flex-grow" />
                <button onClick={onCopy} disabled={lines.length === 0} className={btn} title="Copy all results (with timestamps)">
                    <Copy size={13} />
                </button>
                <button onClick={onSave} disabled={lines.length === 0} className={btn} title="Save results to a file">
                    <Save size={13} />
                </button>
                <button onClick={onClose} className={btn} title="Close results">
                    <X size={13} />
                </button>
            </div>
            <div className="flex-grow min-h-0">
                {searchRe && lines.length > 0 ? (
                    <Virtuoso
                        data={lines}
                        followOutput="auto"
                        initialTopMostItemIndex={lines.length - 1}
                        computeItemKey={(_, line) => line.id}
                        itemContent={(_, line) => (
                            <ResultRow line={line} re={searchRe} text={getText(line)} active={line.id === activeId} onJump={onJump} />
                        )}
                        style={{ height: '100%' }}
                    />
                ) : (
                    <div className="h-full flex items-center justify-center text-xs text-gray-400 italic">
                        {searchRe ? 'No results' : ''}
                    </div>
                )}
            </div>
        </div>
    );
}
