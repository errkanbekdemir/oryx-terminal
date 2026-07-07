import { useState, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Send, Terminal, ChevronDown, Clock, X, BookmarkPlus } from 'lucide-react';
import clsx from 'clsx';
import { Dropdown } from './Dropdown';
import { parseInput } from '../utils/parser';
import { computeChecksum, ChecksumType } from '../utils/checksum';

// Re-export so existing callers (App.tsx, etc.) don't need to change their import path.
export { parseInput } from '../utils/parser';

interface SenderProps {
    isConnected: boolean;
    onSend?: (text: string, data: number[]) => void;
}

const HISTORY_MAX = 100;
const HISTORY_KEY = 'oryx_sendHistory';
const LINE_ENDING_KEY = 'oryx_lineEnding';
const CUSTOM_LINE_ENDING_KEY = 'oryx_customLineEnding';
const CHECKSUM_KEY = 'oryx_checksumType';

type LineEnding = 'None' | 'CR' | 'LF' | 'CRLF' | 'Custom';

function loadHistory(): string[] {
    try {
        const raw: string[] = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
        // Deduplicate in case older versions stored repeated entries
        return raw.filter((v, i, a) => a.indexOf(v) === i);
    } catch { return []; }
}
function saveHistory(h: string[]) {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
}

export function Sender({ isConnected, onSend }: SenderProps) {
    const [input, setInput] = useState('');
    const [lineEnding, setLineEnding] = useState<LineEnding>(() => {
        return (localStorage.getItem(LINE_ENDING_KEY) as LineEnding) ?? 'CRLF';
    });
    const [customEnding, setCustomEnding] = useState(() => {
        return localStorage.getItem(CUSTOM_LINE_ENDING_KEY) ?? '\\r\\n';
    });

    // Persist lineEnding selection across sessions
    useEffect(() => {
        localStorage.setItem(LINE_ENDING_KEY, lineEnding);
    }, [lineEnding]);

    useEffect(() => {
        localStorage.setItem(CUSTOM_LINE_ENDING_KEY, customEnding);
    }, [customEnding]);

    // Validate the custom ending as the user types (same syntax as the command input)
    const customEndingValid = (() => {
        if (lineEnding !== 'Custom') return true;
        try { parseInput(customEnding); return true; } catch { return false; }
    })();

    const [checksumType, setChecksumType] = useState<ChecksumType>(() => {
        return (localStorage.getItem(CHECKSUM_KEY) as ChecksumType) ?? 'none';
    });

    useEffect(() => {
        localStorage.setItem(CHECKSUM_KEY, checksumType);
    }, [checksumType]);

    // History: stored in a ref so mutations don't cause re-renders
    const historyRef = useRef<string[]>(loadHistory());
    // historyIndex as state so React re-renders when browsing state changes
    const [historyIndex, setHistoryIndex] = useState(-1); // -1 = not browsing
    const draftRef = useRef<string>('');                  // draft saved while browsing

    const pushHistory = (text: string) => {
        // Remove all existing occurrences so the entry string is always unique (safe as a React key)
        const deduped = historyRef.current.filter(e => e !== text);
        const next = [text, ...deduped].slice(0, HISTORY_MAX);
        historyRef.current = next;
        saveHistory(next);
    };

    const handleSend = async (raw = false) => {
        if (!isConnected || !input) return;

        const dataBytes = parseInput(input);

        if (!raw) {
            const csBytes = computeChecksum(checksumType, dataBytes);
            dataBytes.push(...csBytes);

            if (lineEnding === 'CR')   dataBytes.push(13);
            if (lineEnding === 'LF')   dataBytes.push(10);
            if (lineEnding === 'CRLF') { dataBytes.push(13); dataBytes.push(10); }
            if (lineEnding === 'Custom') {
                try {
                    dataBytes.push(...parseInput(customEnding));
                } catch (e) {
                    console.error('Invalid custom line ending, sending without it:', e);
                }
            }
        }

        try {
            await invoke('send_data', { data: dataBytes });
            onSend?.(input, dataBytes);
            pushHistory(input);
            setHistoryIndex(-1);
            draftRef.current = '';
            // setInput(''); // Do not clear input after sending
        } catch (e) {
            console.error('Failed to send:', e);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        const key = e.key.toLowerCase();

        if (key === 'enter') {
            e.preventDefault();
            handleSend(e.shiftKey);
            return;
        }

        const h = historyRef.current;
        if (h.length === 0) return;

        if (key === 'arrowup') {
            e.preventDefault();
            if (historyIndex === -1) {
                // Save current draft before browsing
                draftRef.current = input;
            }
            const next = Math.min(historyIndex + 1, h.length - 1);
            setHistoryIndex(next);
            setInput(h[next]);
        } else if (key === 'arrowdown') {
            e.preventDefault();
            if (historyIndex <= 0) {
                // Back to draft
                setHistoryIndex(-1);
                setInput(draftRef.current);
            } else {
                const next = historyIndex - 1;
                setHistoryIndex(next);
                setInput(h[next]);
            }
        } else if (key === 'escape') {
            setHistoryIndex(-1);
            setInput(draftRef.current);
        }
    };

    const isBrowsingHistory = historyIndex !== -1;
    const [historyOpen, setHistoryOpen] = useState(false);

    const selectHistoryEntry = (entry: string) => {
        setHistoryIndex(-1);
        draftRef.current = '';
        setInput(entry);
        setHistoryOpen(false);
    };

    const clearHistory = () => {
        historyRef.current = [];
        saveHistory([]);
        setHistoryIndex(-1);
        setHistoryOpen(false);
    };

    return (
        <div className="flex items-center gap-3 p-3 bg-white dark:bg-[#2b2d31] border-t border-gray-200 dark:border-[#1e1e1e] shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)] dark:shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.3)] z-10 transition-colors duration-200">
            <Dropdown
                label="Line End"
                value={lineEnding}
                options={[
                    { label: 'None', value: 'None' },
                    { label: 'CR (\\r)', value: 'CR' },
                    { label: 'LF (\\n)', value: 'LF' },
                    { label: 'CRLF', value: 'CRLF' },
                    { label: 'Custom', value: 'Custom' },
                ]}
                onChange={setLineEnding}
                direction="up"
            />

            {lineEnding === 'Custom' && (
                <div className="flex flex-col animate-in fade-in duration-150">
                    <label className="text-[8px] uppercase font-bold text-gray-500 tracking-wider mb-0.5 ml-1">Ending</label>
                    <input
                        type="text"
                        value={customEnding}
                        onChange={(e) => setCustomEnding(e.target.value)}
                        placeholder="\r\n"
                        title="Custom line ending — supports \r, \n, \h(XX), 0x.. (same syntax as the command input)"
                        className={clsx(
                            "w-24 bg-gray-100 dark:bg-[#151515] border rounded px-2 py-2 text-xs font-mono text-gray-800 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-600 focus:outline-none focus:ring-1 shadow-inner transition-all",
                            customEndingValid
                                ? "border-gray-300 dark:border-gray-600 focus:border-blue-500 focus:ring-blue-500"
                                : "border-red-400 dark:border-red-600 focus:border-red-500 focus:ring-red-500"
                        )}
                    />
                </div>
            )}

            <Dropdown
                label="Checksum"
                value={checksumType}
                options={[
                    { label: 'None',      value: 'none' },
                    { label: 'XOR',       value: 'xor' },
                    { label: 'LRC',       value: 'lrc' },
                    { label: 'CRC-8',     value: 'crc8' },
                    { label: 'CRC-16/MB', value: 'crc16-modbus' },
                    { label: 'CRC-CCITT', value: 'crc-ccitt' },
                ]}
                onChange={(v) => setChecksumType(v as ChecksumType)}
                direction="up"
            />

            <div className="flex-grow min-w-0 relative flex flex-col group/input">
                <label className="text-[8px] uppercase font-bold text-gray-500 tracking-wider mb-0.5 ml-1">
                    Data / Command
                    {historyRef.current.length > 0 && (
                        <span className="ml-2 normal-case text-[8px] font-normal italic">
                            {isBrowsingHistory
                                ? <span className="text-amber-500">&#8593;&#8595; history ({historyIndex + 1}/{historyRef.current.length})</span>
                                : <span className="text-gray-400 dark:text-gray-500">&#8593;&#8595; history</span>
                            }
                        </span>
                    )}
                </label>
                <div className="relative w-full">
                    <div className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-600 pointer-events-none">
                        <Terminal size={13} />
                    </div>
                    <input
                        type="text"
                        value={input}
                        onChange={(e) => { setHistoryIndex(-1); setInput(e.target.value); }}
                        onKeyDown={handleKeyDown}
                        disabled={!isConnected}
                        placeholder={isConnected ? "Try: \\h(48 69) or 0x4F" : "Connect to send"}
                        className={clsx(
                            "w-full bg-gray-100 dark:bg-[#151515] border rounded pl-8 py-2 text-sm text-gray-800 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-600 focus:outline-none focus:ring-1 disabled:opacity-50 disabled:cursor-not-allowed font-mono shadow-inner transition-all",
                            historyRef.current.length > 0 ? "pr-14" : "pr-4",
                            isBrowsingHistory
                                ? "border-amber-400 dark:border-amber-600 focus:border-amber-400 focus:ring-amber-400"
                                : "border-gray-300 dark:border-gray-600 focus:border-blue-500 focus:ring-blue-500"
                        )}
                    />

                    {/* Integrated History Dropdown Button */}
                    {historyRef.current.length > 0 && (
                        <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center h-[28px] border-l border-gray-300 dark:border-gray-700 pl-1">
                            <button
                                type="button"
                                onClick={() => setHistoryOpen(!historyOpen)}
                                className={clsx(
                                    "flex items-center gap-0.5 px-1.5 py-1 rounded transition-all hover:bg-gray-200 dark:hover:bg-white/10",
                                    historyOpen
                                        ? "text-amber-500 bg-amber-500/5"
                                        : "text-gray-400 dark:text-gray-500"
                                )}
                                title="Show search history"
                            >
                                <Clock size={13} />
                                <ChevronDown size={12} className={clsx("transition-transform duration-200", historyOpen && "rotate-180")} />
                            </button>
                        </div>
                    )}

                    {/* History Dropdown List */}
                    {historyOpen && historyRef.current.length > 0 && (
                        <>
                            <div className="fixed inset-0 z-40" onClick={() => setHistoryOpen(false)} />
                            <div className="absolute bottom-full left-0 w-full mb-1 bg-white dark:bg-[#1a1c20] border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl z-50 overflow-hidden animate-fade-in">
                                <ul className="max-h-64 overflow-y-auto py-1 custom-scrollbar">
                                    {historyRef.current.map((entry, i) => (
                                        <li
                                            key={entry}
                                            className={clsx(
                                                "group/item flex items-center justify-between px-3 py-2 text-xs font-mono cursor-pointer transition-colors border-l-2",
                                                i === historyIndex
                                                    ? "bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 border-amber-500"
                                                    : "text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/5 border-transparent"
                                            )}
                                        >
                                            <span className="truncate flex-grow" onClick={() => selectHistoryEntry(entry)}>{entry}</span>
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    window.dispatchEvent(new CustomEvent('oryx-add-macro', { detail: { command: entry } }));
                                                    setHistoryOpen(false);
                                                }}
                                                className="opacity-0 group-hover/item:opacity-100 p-1 hover:bg-blue-100 dark:hover:bg-blue-900/40 text-blue-600 dark:text-blue-400 rounded transition-all"
                                                title="Save as macro"
                                            >
                                                <BookmarkPlus size={14} />
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                                <div className="border-t border-gray-100 dark:border-gray-800 px-3 py-1.5 flex justify-between items-center bg-gray-50/50 dark:bg-white/5">
                                    <span className="text-[9px] text-gray-500 font-bold uppercase tracking-tighter">{historyRef.current.length} items</span>
                                    <button
                                        onClick={clearHistory}
                                        className="flex items-center gap-1.5 text-[10px] text-red-400 hover:text-red-500 transition-colors font-bold uppercase"
                                    >
                                        <X size={11} /> Clear
                                    </button>
                                </div>
                            </div>
                        </>
                    )}
                </div>
            </div>

            <button
                onClick={(e) => handleSend(e.shiftKey)}
                disabled={!isConnected || !input}
                className="mt-4 p-2.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all transform active:scale-95 shadow-lg flex-shrink-0"
                title="Send (Enter) · Shift+Click or Shift+Enter to send without EOL"
            >
                <Send size={18} />
            </button>
        </div>
    );
}
