import { useEffect, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';

export interface ModemLines {
    cts: boolean;
    dsr: boolean;
    cd: boolean;
    ri: boolean;
}

/**
 * Polls CTS/DSR/CD/RI every 500 ms while `active`, and exposes manual RTS/DTR
 * control. Desired RTS/DTR levels live in the Rust backend for the session and
 * are re-applied automatically after reconnects — the local state here only
 * mirrors what the user last set.
 */
export function useModemLines(active: boolean) {
    const [modemLines, setModemLines] = useState<ModemLines | null>(null);
    const [rts, setRtsState] = useState(false);
    const [dtr, setDtrState] = useState(false);

    useEffect(() => {
        if (!active) {
            setModemLines(null);
            return;
        }
        let cancelled = false;
        const poll = async () => {
            try {
                const lines = await invoke<ModemLines>('read_modem_lines');
                if (!cancelled) setModemLines(lines);
            } catch {
                if (!cancelled) setModemLines(null); // disconnected / reconnect gap
            }
        };
        poll();
        const interval = setInterval(poll, 500);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [active]);

    const setRts = useCallback((level: boolean) => {
        setRtsState(level);
        invoke('set_rts', { level }).catch(e => console.error('Failed to set RTS:', e));
    }, []);

    const setDtr = useCallback((level: boolean) => {
        setDtrState(level);
        invoke('set_dtr', { level }).catch(e => console.error('Failed to set DTR:', e));
    }, []);

    return { modemLines, rts, dtr, setRts, setDtr };
}
