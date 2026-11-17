import { ReactNode, RefObject } from 'react';
import clsx from 'clsx';
import { Search, CaseSensitive, ListFilter, ChevronUp, ChevronDown, X } from 'lucide-react';

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Literal (non-regex) search; the `i` flag keeps match offsets aligned with
 *  the original text, unlike lowercasing both sides (e.g. Turkish İ). */
export function makeSearchRegex(query: string, caseSensitive: boolean): RegExp | null {
    return query ? new RegExp(escapeRegExp(query), caseSensitive ? 'g' : 'gi') : null;
}

export function findRanges(text: string, re: RegExp): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (const m of text.matchAll(re)) out.push([m.index, m.index + m[0].length]);
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
    filterOnly: boolean;
    onToggleFilter: () => void;
    /** 1-based position of the active match, 0 if none */
    current: number;
    total: number;
    onOlder: () => void;
    onNewer: () => void;
    onClose: () => void;
}

export function TerminalSearchBar({
    inputRef, query, onQueryChange, caseSensitive, onToggleCase, filterOnly, onToggleFilter,
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
            <span className={clsx('text-[10px] font-mono tabular-nums min-w-[52px] text-right pr-1', query && total === 0 ? 'text-red-500' : 'text-gray-500 dark:text-gray-400')}>
                {query ? (total === 0 ? 'No results' : `${current}/${total}`) : ''}
            </span>
            <button onClick={onToggleCase} className={toggleClass(caseSensitive)} title="Match case">
                <CaseSensitive size={14} />
            </button>
            <button onClick={onToggleFilter} className={toggleClass(filterOnly)} title="Show only matching lines">
                <ListFilter size={13} />
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
