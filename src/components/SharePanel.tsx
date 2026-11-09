import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Copy, Check, Share2, Square, RotateCcw } from 'lucide-react';

interface ShareInfo {
    addresses: string[];
    port: number;
    token: string;
    discoverable: boolean;
}

interface ShareStatus {
    info: ShareInfo;
    client: string | null;
    bytes_in: number;
    bytes_out: number;
}

interface SharePanelProps {
    isConnected: boolean;
    isRemote: boolean;
}

const readLocal = <T,>(key: string, fallback: T): T => {
    try {
        const v = localStorage.getItem(key);
        return v ? JSON.parse(v) : fallback;
    } catch {
        return fallback;
    }
};

const formatBytes = (n: number) =>
    n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

function CopyButton({ text }: { text: string }) {
    const [copied, setCopied] = useState(false);
    return (
        <button
            onClick={() => {
                navigator.clipboard.writeText(text).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                }).catch(() => {});
            }}
            className="p-1 rounded-md text-gray-400 hover:text-blue-500 hover:bg-gray-100 dark:hover:bg-white/10 transition-all"
            title="Copy"
        >
            {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
        </button>
    );
}

export function SharePanel({ isConnected, isRemote }: SharePanelProps) {
    const [status, setStatus] = useState<ShareStatus | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [discoverable, setDiscoverable] = useState<boolean>(() => readLocal('oryx_shareDiscoverable', true));
    // Token is kept across sessions so the remote side doesn't need a new one every time
    const [savedToken, setSavedToken] = useState<string | null>(() => readLocal('oryx_shareToken', null));

    useEffect(() => {
        try { localStorage.setItem('oryx_shareDiscoverable', JSON.stringify(discoverable)); } catch { /* ignore */ }
    }, [discoverable]);
    useEffect(() => {
        try { localStorage.setItem('oryx_shareToken', JSON.stringify(savedToken)); } catch { /* ignore */ }
    }, [savedToken]);

    const refresh = useCallback(async () => {
        try {
            setStatus(await invoke<ShareStatus | null>('get_share_status'));
        } catch (e) {
            console.error('Failed to get share status:', e);
        }
    }, []);

    useEffect(() => {
        refresh();
        const interval = setInterval(refresh, 2000);
        return () => clearInterval(interval);
    }, [refresh]);

    const start = async () => {
        setBusy(true);
        setError(null);
        try {
            const info = await invoke<ShareInfo>('start_share', { listenPort: null, token: savedToken, discoverable });
            setSavedToken(info.token);
            await refresh();
        } catch (e) {
            setError(String(e));
        } finally {
            setBusy(false);
        }
    };

    const stop = async () => {
        setBusy(true);
        try {
            await invoke('stop_share');
            await refresh();
        } finally {
            setBusy(false);
        }
    };

    const sharing = status !== null;

    return (
        <section>
            <h3 className="text-sm font-bold uppercase text-gray-500 dark:text-gray-400 mb-4 tracking-wider flex items-center gap-2">
                <Share2 size={14} /> Network Share
            </h3>

            {!sharing ? (
                <div className="space-y-3">
                    <p className="text-[10px] text-gray-400 dark:text-gray-500 italic pl-1">
                        Share the open serial port with another ORYX over the network. Traffic is end-to-end encrypted with the share token.
                    </p>
                    <label className="flex items-center gap-3 group cursor-pointer">
                        <input
                            type="checkbox"
                            checked={discoverable}
                            onChange={(e) => setDiscoverable(e.target.checked)}
                            className="w-4 h-4 rounded-md border-gray-300 text-blue-500 focus:ring-blue-500 dark:bg-[#1a1c20] dark:border-[#40444b]"
                        />
                        <div className="flex flex-col">
                            <span className="text-xs font-bold text-gray-700 dark:text-gray-200 group-hover:text-blue-500 transition-colors">Discoverable on LAN</span>
                            <span className="text-[10px] text-gray-400 dark:text-gray-500 italic">Announce via mDNS so others can find it with Scan — the token is still required</span>
                        </div>
                    </label>
                    <div className="flex gap-2">
                        <button
                            onClick={start}
                            disabled={!isConnected || isRemote || busy}
                            className="flex-1 flex items-center justify-center gap-2 text-sm py-2.5 rounded-xl font-bold bg-blue-500 hover:bg-blue-600 text-white shadow-lg shadow-blue-500/20 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
                        >
                            <Share2 size={14} /> Start Sharing
                        </button>
                        {savedToken && (
                            <button
                                onClick={() => setSavedToken(null)}
                                disabled={busy}
                                className="px-3 rounded-xl border border-gray-200 dark:border-[#303339] text-gray-500 hover:text-amber-500 hover:border-amber-400 transition-all"
                                title="Generate a new token next time (revokes the old one)"
                            >
                                <RotateCcw size={14} />
                            </button>
                        )}
                    </div>
                    {!isConnected && !isRemote && (
                        <p className="text-[10px] text-gray-400 dark:text-gray-500 italic pl-1">Connect to a serial port first.</p>
                    )}
                    {isRemote && (
                        <p className="text-[10px] text-gray-400 dark:text-gray-500 italic pl-1">Not available while connected to a remote share.</p>
                    )}
                    {error && <p className="text-[11px] text-red-500 pl-1">{error}</p>}
                </div>
            ) : (
                <div className="space-y-3">
                    <div className="rounded-xl border border-gray-200 dark:border-[#303339] bg-gray-50 dark:bg-[#1a1c20] p-3 space-y-2">
                        <div className="flex items-center justify-between">
                            <span className="text-[10px] font-bold uppercase text-gray-500 tracking-wide">Token</span>
                            <div className="flex items-center gap-1">
                                <span className="font-mono text-sm font-bold text-gray-800 dark:text-gray-100 select-all">{status.info.token}</span>
                                <CopyButton text={status.info.token} />
                            </div>
                        </div>
                        <div className="flex items-start justify-between gap-4">
                            <span className="text-[10px] font-bold uppercase text-gray-500 tracking-wide pt-1">Address</span>
                            <div className="flex flex-col items-end">
                                {status.info.addresses.length === 0 ? (
                                    <span className="text-xs text-gray-400 italic">port {status.info.port} (no LAN address found)</span>
                                ) : status.info.addresses.map(a => (
                                    <div key={a} className="flex items-center gap-1">
                                        <span className="font-mono text-xs text-gray-700 dark:text-gray-300 select-all">{a}</span>
                                        <CopyButton text={a} />
                                    </div>
                                ))}
                            </div>
                        </div>
                        <div className="flex items-center justify-between pt-1 border-t border-gray-200 dark:border-[#303339]">
                            <span className="flex items-center gap-2 text-[11px] font-bold">
                                <span className={`w-1.5 h-1.5 rounded-full ${status.client ? 'bg-green-500 animate-pulse' : 'bg-gray-400'}`} />
                                <span className={status.client ? 'text-green-600 dark:text-green-400' : 'text-gray-500'}>
                                    {status.client ? `Client: ${status.client}` : 'Waiting for client...'}
                                </span>
                            </span>
                            <span className="text-[10px] text-gray-400 font-mono">
                                ↑{formatBytes(status.bytes_out)} ↓{formatBytes(status.bytes_in)}
                            </span>
                        </div>
                    </div>
                    <p className="text-[10px] text-gray-400 dark:text-gray-500 italic pl-1">
                        {status.info.discoverable ? 'Discoverable on LAN. ' : ''}Listening on all interfaces — your OS firewall may ask to allow incoming connections.
                    </p>
                    <button
                        onClick={stop}
                        disabled={busy}
                        className="w-full flex items-center justify-center gap-2 text-sm py-2.5 rounded-xl font-bold bg-red-500 hover:bg-red-600 text-white transition-all active:scale-95 disabled:opacity-50"
                    >
                        <Square size={12} fill="white" strokeWidth={0} /> Stop Sharing
                    </button>
                </div>
            )}
        </section>
    );
}
