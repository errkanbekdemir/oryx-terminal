import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { X, Settings as SettingsIcon } from 'lucide-react';
import clsx from 'clsx';
import { Dropdown } from './Dropdown';
import { useSettings } from '../contexts/SettingsContext';

interface SettingsPanelProps {
    isOpen: boolean;
    onClose: () => void;
    isConnected: boolean;
}

export function SettingsPanel({ isOpen, onClose, isConnected }: SettingsPanelProps) {
    const {
        dataBits, setDataBits, stopBits, setStopBits, parity, setParity,
        flowControl, setFlowControl, invertRts, setInvertRts, invertDtr, setInvertDtr,
        invertCts, setInvertCts, invertDsr, setInvertDsr, invertCd, setInvertCd, invertRi, setInvertRi,
        rs485PreDelayMs, setRs485PreDelayMs, viewMode, setViewMode,
        breakMode, setBreakMode, breakAfterBytesCount, setBreakAfterBytesCount,
        breakBeforeSequenceValue, setBreakBeforeSequenceValue,
        breakBeforeSequenceEnabled, setBreakBeforeSequenceEnabled,
        breakAfterSequenceValue, setBreakAfterSequenceValue,
        breakAfterSequenceEnabled, setBreakAfterSequenceEnabled,
        breakAfterTimeoutMs, setBreakAfterTimeoutMs,
        eolSequence, setEolSequence, showEol, setShowEol,
        maxLines, setMaxLines,
        logPath, setLogPath, isLogging, setIsLogging,
        autoReconnect, setAutoReconnect, reconnectTimeoutSec, setReconnectTimeoutSec,
    } = useSettings();

    // Hooks must be called unconditionally — before the early return
    const [showCustomInput, setShowCustomInput] = useState(
        () => !['\\n', '\\r\\n', '\\r'].includes(eolSequence)
    );

    // Re-sync when panel is opened in case eolSequence changed while panel was closed
    useEffect(() => {
        if (isOpen) {
            setShowCustomInput(!['\\n', '\\r\\n', '\\r'].includes(eolSequence));
        }
    }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

    // Flow control can be reconfigured on an already-open port — push it to
    // the backend immediately instead of waiting for the next connect.
    const handleFlowControlChange = (v: string) => {
        setFlowControl(v);
        if (isConnected) {
            invoke('set_flow_control', { flowControl: v }).catch(e => console.error('Failed to apply flow control:', e));
        }
    };

    // Many USB-UART chips (FTDI's RTS#/DTR# included) drive these pins
    // active-low in hardware, so "asserted" in software comes out low on the
    // wire. These invert the level written to the physical pin.
    const handleInvertRtsChange = (v: boolean) => {
        setInvertRts(v);
        if (isConnected) {
            invoke('set_invert_rts', { invert: v }).catch(e => console.error('Failed to invert RTS:', e));
        }
    };
    const handleInvertDtrChange = (v: boolean) => {
        setInvertDtr(v);
        if (isConnected) {
            invoke('set_invert_dtr', { invert: v }).catch(e => console.error('Failed to invert DTR:', e));
        }
    };
    // Same active-low convention applies to the input status lines.
    const handleInvertCtsChange = (v: boolean) => {
        setInvertCts(v);
        if (isConnected) {
            invoke('set_invert_cts', { invert: v }).catch(e => console.error('Failed to invert CTS:', e));
        }
    };
    const handleInvertDsrChange = (v: boolean) => {
        setInvertDsr(v);
        if (isConnected) {
            invoke('set_invert_dsr', { invert: v }).catch(e => console.error('Failed to invert DSR:', e));
        }
    };
    const handleInvertCdChange = (v: boolean) => {
        setInvertCd(v);
        if (isConnected) {
            invoke('set_invert_cd', { invert: v }).catch(e => console.error('Failed to invert DCD:', e));
        }
    };
    const handleInvertRiChange = (v: boolean) => {
        setInvertRi(v);
        if (isConnected) {
            invoke('set_invert_ri', { invert: v }).catch(e => console.error('Failed to invert RI:', e));
        }
    };

    // RS-485 only: how long to wait after driving RTS/DE high before the
    // actual data write, giving the transceiver time to switch to transmit.
    const handleRs485PreDelayChange = (v: number) => {
        const ms = Math.max(0, v);
        setRs485PreDelayMs(ms);
        if (isConnected) {
            invoke('set_rs485_pre_delay', { delayMs: ms }).catch(e => console.error('Failed to set RS-485 pre-delay:', e));
        }
    };

    if (!isOpen) return null;

    const handleBrowseLogPath = async () => {
        try {
            const selected = await save({
                title: 'Select Log File Location',
                defaultPath: logPath || 'session_log.txt',
                filters: [{ name: 'Text Documents', extensions: ['txt', 'log'] }],
            });
            if (selected) setLogPath(selected);
        } catch (e) {
            console.error('Failed to open save dialog:', e);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            {/* Backdrop */}
            <div
                className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity"
                onClick={onClose}
            />

            {/* Panel */}
            <div className="relative bg-white dark:bg-[#25282e] w-full max-w-lg rounded-xl shadow-2xl border border-gray-200 dark:border-[#303339] flex flex-col max-h-[90vh] overflow-hidden animate-in fade-in zoom-in duration-200">
                {/* Header */}
                <div className="px-6 py-4 border-b border-gray-100 dark:border-[#303339] flex items-center justify-between bg-gray-50/50 dark:bg-[#2a2d33]">
                    <div className="flex items-center gap-2">
                        <SettingsIcon size={20} className="text-blue-500" />
                        <h2 className="text-lg font-bold text-gray-800 dark:text-gray-100 italic tracking-tight">Settings</h2>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-1.5 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg transition-colors text-gray-500 dark:text-gray-400"
                    >
                        <X size={20} />
                    </button>
                </div>

                {/* Content */}
                <div className="p-6 overflow-y-auto custom-scrollbar space-y-8">
                    {/* Serial Options */}
                    <section>
                        <h3 className="text-sm font-bold uppercase text-gray-500 dark:text-gray-400 mb-4 tracking-wider flex items-center gap-2">
                            Serial Configuration
                        </h3>
                        <div className="grid grid-cols-2 gap-4">
                            <Dropdown
                                label="Data Bits"
                                value={dataBits}
                                options={[
                                    { label: '5 Bits', value: 5 },
                                    { label: '6 Bits', value: 6 },
                                    { label: '7 Bits', value: 7 },
                                    { label: '8 Bits', value: 8 },
                                ]}
                                onChange={setDataBits}
                            />
                            <Dropdown
                                label="Stop Bits"
                                value={stopBits}
                                options={[
                                    { label: '1 Bit', value: 1 },
                                    { label: '2 Bits', value: 2 },
                                ]}
                                onChange={setStopBits}
                            />
                            <Dropdown
                                label="Parity"
                                value={parity}
                                options={[
                                    { label: 'None', value: 'None' },
                                    { label: 'Odd', value: 'Odd' },
                                    { label: 'Even', value: 'Even' },
                                ]}
                                onChange={setParity}
                            />
                            <Dropdown
                                label="Flow Control"
                                value={flowControl}
                                options={[
                                    { label: 'None', value: 'None' },
                                    { label: 'Software (XOn/XOff)', value: 'Software' },
                                    { label: 'Hardware (RTS/CTS)', value: 'Hardware' },
                                    { label: 'Combined (RTS/CTS + XOn/XOff)', value: 'combined' },
                                    { label: 'Manual Hardware (RTS/CTS)', value: 'manual_hardware' },
                                    { label: 'Manual Software (XOn/XOff)', value: 'manual_software' },
                                    { label: 'Manual Combined (RTS/CTS + XOn/XOff)', value: 'manual_combined' },
                                    { label: 'Half-Duplex Modem (DCD/RTS/CTS)', value: 'half_duplex' },
                                    { label: 'RS-485 Transceiver Control (RTS)', value: 'rs485' },
                                ]}
                                onChange={handleFlowControlChange}
                            />
                        </div>
                        <p className="mt-2 text-[9px] text-gray-400 dark:text-gray-500 italic pl-1">
                            Manual, half-duplex, and RS-485 modes gate TX in the app (CTS wait / XOFF pause / RTS keying). Flow control applies immediately if connected; other port settings apply on next connect.
                        </p>

                        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
                            <label className="flex items-center gap-3 group cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={invertRts}
                                    onChange={(e) => handleInvertRtsChange(e.target.checked)}
                                    className="w-4 h-4 rounded-md border-gray-300 text-blue-500 focus:ring-blue-500 dark:bg-[#1a1c20] dark:border-[#40444b] transition-all"
                                />
                                <span className="text-xs text-gray-600 dark:text-gray-400 group-hover:text-blue-500 transition-colors font-bold tracking-tight">Invert RTS</span>
                            </label>
                            <label className="flex items-center gap-3 group cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={invertDtr}
                                    onChange={(e) => handleInvertDtrChange(e.target.checked)}
                                    className="w-4 h-4 rounded-md border-gray-300 text-blue-500 focus:ring-blue-500 dark:bg-[#1a1c20] dark:border-[#40444b] transition-all"
                                />
                                <span className="text-xs text-gray-600 dark:text-gray-400 group-hover:text-blue-500 transition-colors font-bold tracking-tight">Invert DTR</span>
                            </label>
                            <label className="flex items-center gap-3 group cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={invertCts}
                                    onChange={(e) => handleInvertCtsChange(e.target.checked)}
                                    className="w-4 h-4 rounded-md border-gray-300 text-blue-500 focus:ring-blue-500 dark:bg-[#1a1c20] dark:border-[#40444b] transition-all"
                                />
                                <span className="text-xs text-gray-600 dark:text-gray-400 group-hover:text-blue-500 transition-colors font-bold tracking-tight">Invert CTS</span>
                            </label>
                            <label className="flex items-center gap-3 group cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={invertDsr}
                                    onChange={(e) => handleInvertDsrChange(e.target.checked)}
                                    className="w-4 h-4 rounded-md border-gray-300 text-blue-500 focus:ring-blue-500 dark:bg-[#1a1c20] dark:border-[#40444b] transition-all"
                                />
                                <span className="text-xs text-gray-600 dark:text-gray-400 group-hover:text-blue-500 transition-colors font-bold tracking-tight">Invert DSR</span>
                            </label>
                            <label className="flex items-center gap-3 group cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={invertCd}
                                    onChange={(e) => handleInvertCdChange(e.target.checked)}
                                    className="w-4 h-4 rounded-md border-gray-300 text-blue-500 focus:ring-blue-500 dark:bg-[#1a1c20] dark:border-[#40444b] transition-all"
                                />
                                <span className="text-xs text-gray-600 dark:text-gray-400 group-hover:text-blue-500 transition-colors font-bold tracking-tight">Invert DCD</span>
                            </label>
                            <label className="flex items-center gap-3 group cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={invertRi}
                                    onChange={(e) => handleInvertRiChange(e.target.checked)}
                                    className="w-4 h-4 rounded-md border-gray-300 text-blue-500 focus:ring-blue-500 dark:bg-[#1a1c20] dark:border-[#40444b] transition-all"
                                />
                                <span className="text-xs text-gray-600 dark:text-gray-400 group-hover:text-blue-500 transition-colors font-bold tracking-tight">Invert RI</span>
                            </label>
                        </div>
                        <p className="mt-1 text-[9px] text-gray-400 dark:text-gray-500 italic pl-1">
In RS-232, logical HIGH is a negative voltage and LOW is positive. USB-TTL chips like FTDI/CH340 implement RTS#/DTR# active-low — the chip pulls the pin to GND (0V) when it receives an "asserted" command.
                        </p>

                        {flowControl === 'rs485' && (
                            <div className="mt-3">
                                <label className="flex items-center gap-3">
                                    <span className="text-xs text-gray-600 dark:text-gray-400 font-bold tracking-tight whitespace-nowrap">RS-485 Pre-TX Delay</span>
                                    <input
                                        type="number"
                                        min={0}
                                        step={1}
                                        value={rs485PreDelayMs}
                                        onChange={(e) => handleRs485PreDelayChange(Number(e.target.value))}
                                        className="w-20 bg-white dark:bg-[#1a1c20] border border-gray-200 dark:border-[#303339] rounded-lg px-2 py-1 text-xs text-gray-900 dark:text-gray-100 outline-none focus:ring-1 focus:ring-blue-500 shadow-sm font-mono"
                                    />
                                    <span className="text-[10px] text-gray-400">ms</span>
                                </label>
                                <p className="mt-1 text-[9px] text-gray-400 dark:text-gray-500 italic pl-1">
                                    Wait this long after driving RTS/DE high before writing data — gives the transceiver time to switch into transmit mode. 0 disables the delay.
                                </p>
                            </div>
                        )}
                    </section>

                    {/* Display Settings Section */}
                    <section className="space-y-4">
                        <div className="flex items-center justify-between">
                            <div className="flex flex-col">
                                <h3 className="text-sm font-bold uppercase text-gray-500 dark:text-gray-400 tracking-wider flex items-center gap-2">
                                    Display Settings
                                </h3>
                                <p className="text-[10px] text-gray-400 dark:text-gray-500 italic mt-0.5">Control how data is split into lines based on your mode.</p>
                            </div>
                        </div>

                        <div className="space-y-6 pt-2">
                            {/* Terminal View Mode */}
                            <div className="p-3 rounded-xl bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10 space-y-4 shadow-sm">
                                <div className="flex flex-col gap-3">
                                    <div className="flex items-center justify-between">
                                        <div className="flex flex-col">
                                            <span className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 tracking-tight">Terminal View Mode</span>
                                            <p className="text-[9px] text-gray-400 dark:text-gray-500 italic mt-0.5">Toggle between stream categories</p>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-2 gap-2 p-1 bg-gray-100 dark:bg-[#1a1c20] rounded-lg border border-gray-200/50 dark:border-white/5">
                                        <button
                                            onClick={() => setViewMode('text')}
                                            className={clsx(
                                                'px-3 py-1.5 rounded-md text-[10px] font-black tracking-widest transition-all duration-200',
                                                viewMode === 'text'
                                                    ? 'bg-white dark:bg-[#2a2d33] text-blue-500 shadow-md ring-1 ring-blue-500/20'
                                                    : 'text-gray-500 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                                            )}
                                        >
                                            TEXT
                                        </button>
                                        <button
                                            onClick={() => { if (viewMode === 'text') setViewMode('hex'); }}
                                            className={clsx(
                                                'px-3 py-1.5 rounded-md text-[10px] font-black tracking-widest transition-all duration-200',
                                                viewMode !== 'text'
                                                    ? 'bg-white dark:bg-[#2a2d33] text-green-500 shadow-md ring-1 ring-green-500/20'
                                                    : 'text-gray-500 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                                            )}
                                        >
                                            BINARY
                                        </button>
                                    </div>

                                    {viewMode !== 'text' && (
                                        <div className="pt-1 animate-in fade-in duration-150 bg-green-500/5 rounded-lg border border-green-500/10 p-2">
                                            <Dropdown
                                                label="Diagnostic Format"
                                                value={viewMode}
                                                options={[
                                                    { label: 'Hexadecimal', value: 'hex' },
                                                    { label: 'Char (ASCII)', value: 'char' },
                                                    { label: 'Decimal', value: 'dec' },
                                                    { label: 'Octal', value: 'oct' },
                                                    { label: 'Binary', value: 'bin' },
                                                ]}
                                                onChange={setViewMode}
                                            />
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Display Buffer Limit */}
                            <div className="p-3 rounded-xl bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10 space-y-3 shadow-sm">
                                <div className="flex flex-col">
                                    <span className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 tracking-tight">Display Buffer Limit</span>
                                    <p className="text-[9px] text-gray-400 dark:text-gray-500 italic mt-0.5">Maximum lines kept on screen — older lines are dropped (log files are unaffected)</p>
                                </div>
                                <Dropdown
                                    label="Max Lines"
                                    value={maxLines}
                                    options={[
                                        { label: '1,000 lines', value: 1_000 },
                                        { label: '5,000 lines', value: 5_000 },
                                        { label: '10,000 lines', value: 10_000 },
                                        { label: '50,000 lines', value: 50_000 },
                                        { label: '100,000 lines', value: 100_000 },
                                    ]}
                                    onChange={setMaxLines}
                                />
                            </div>

                            {/* EOL Settings */}
                            <div className="p-3 rounded-xl bg-blue-50/50 dark:bg-blue-500/5 border border-blue-100 dark:border-blue-900/20 space-y-3 shadow-sm transition-all">
                                <div className="flex items-center justify-between">
                                    <div className="flex flex-col">
                                        <span className="text-[10px] font-bold uppercase text-blue-600 dark:text-blue-400 tracking-tight">EOL Settings</span>
                                        <span className="text-[9px] text-blue-500/70 dark:text-blue-400/50 font-medium tracking-tighter">Required for Text mode newline</span>
                                    </div>
                                    {viewMode === 'text' && (
                                        <span className="text-[9px] bg-blue-500 text-white px-1.5 py-0.5 rounded-full font-black shadow-sm uppercase tracking-tighter">Active Mode</span>
                                    )}
                                </div>

                                <Dropdown
                                    label="Sequence"
                                    value={showCustomInput ? 'custom' : eolSequence}
                                    options={[
                                        { label: 'LF (\\n)', value: '\\n' },
                                        { label: 'CRLF (\\r\\n)', value: '\\r\\n' },
                                        { label: 'CR (\\r)', value: '\\r' },
                                        { label: 'Custom', value: 'custom' },
                                    ]}
                                    onChange={(val) => {
                                        if (val === 'custom') {
                                            setShowCustomInput(true);
                                        } else {
                                            setShowCustomInput(false);
                                            setEolSequence(val);
                                        }
                                    }}
                                />

                                {showCustomInput && (
                                    <div className="flex flex-col gap-1 animate-in fade-in duration-150 pl-1">
                                        <input
                                            type="text"
                                            value={eolSequence}
                                            onChange={(e) => setEolSequence(e.target.value)}
                                            placeholder="e.g. [END]"
                                            className="w-full bg-white dark:bg-[#1a1c20] border border-gray-200 dark:border-[#303339] rounded-lg px-3 py-1.5 text-xs text-gray-900 dark:text-gray-100 outline-none focus:ring-1 focus:ring-blue-500 shadow-sm font-mono"
                                        />
                                        <p className="text-[9px] text-gray-400 italic leading-none pl-1">Supports \r, \n, and hex \h(XX)</p>
                                    </div>
                                )}

                                <label className="flex items-center gap-3 group cursor-pointer pt-1">
                                    <input
                                        type="checkbox"
                                        checked={showEol}
                                        onChange={(e) => setShowEol(e.target.checked)}
                                        className="w-4 h-4 rounded-md border-gray-300 text-blue-500 focus:ring-blue-500 dark:bg-[#1a1c20] dark:border-[#40444b] transition-all"
                                    />
                                    <span className="text-xs text-gray-600 dark:text-gray-400 group-hover:text-blue-500 transition-colors font-bold tracking-tight">Show EOL indicators (↵)</span>
                                </label>
                            </div>

                            {/* Binary Breaking Strategy */}
                            <div className={clsx('space-y-4 transition-all duration-300', {
                                'opacity-30 grayscale pointer-events-none scale-[0.98]': viewMode === 'text',
                                'p-3 rounded-xl bg-green-50/20 dark:bg-green-500/5 border border-green-100/50 dark:border-green-900/10 shadow-sm': viewMode !== 'text',
                            })}>
                                <div className="flex items-center justify-between">
                                    <div className="flex flex-col">
                                        <span className="text-[10px] font-black uppercase text-gray-500 dark:text-gray-400 tracking-tight">Binary Breaking Strategy</span>
                                        <span className="text-[9px] text-gray-400 dark:text-gray-500 font-medium tracking-tighter">Breaking for Hex, Bin, Char, etc.</span>
                                    </div>
                                    {viewMode !== 'text' && (
                                        <span className="text-[9px] bg-green-500 text-white px-2 py-0.5 rounded-full font-black shadow-sm uppercase tracking-tighter">Active Mode</span>
                                    )}
                                </div>

                                {viewMode === 'text' && (
                                    <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-2 flex gap-2 items-center animate-in fade-in duration-150 shadow-inner">
                                        <p className="text-[9px] text-amber-600 dark:text-amber-400 font-black italic tracking-tight leading-tight">
                                            Text Mode wait for EOL active. Diagnostic strategies are disabled.
                                        </p>
                                    </div>
                                )}

                                <div className="space-y-3 pl-0.5">
                                    {/* None */}
                                    <div className="space-y-1">
                                        <label className="flex items-center gap-3 group cursor-pointer transition-all">
                                            <input
                                                type="radio"
                                                name="breakMode"
                                                checked={breakMode === 'none'}
                                                onChange={() => setBreakMode('none')}
                                                className="w-4 h-4 border-gray-300 text-blue-500 focus:ring-blue-500 dark:bg-[#1a1c20] dark:border-[#40444b]"
                                            />
                                            <span className="text-xs text-gray-700 dark:text-gray-300 group-hover:text-blue-500 transition-colors font-bold tracking-tight">No breaking (Raw data)</span>
                                        </label>
                                        {breakMode === 'none' && (
                                            <p className="ml-7 text-[9px] text-amber-600 dark:text-amber-400 italic animate-in fade-in duration-150">
                                                Data renders every ~50ms (force-flush). Best for raw continuous streams.
                                            </p>
                                        )}
                                    </div>

                                    <label className="flex items-center gap-3 group cursor-pointer transition-all">
                                        <input
                                            type="radio"
                                            name="breakMode"
                                            checked={breakMode === 'chunk'}
                                            onChange={() => setBreakMode('chunk')}
                                            className="w-4 h-4 border-gray-300 text-blue-500 focus:ring-blue-500 dark:bg-[#1a1c20] dark:border-[#40444b]"
                                        />
                                        <span className="text-xs text-gray-700 dark:text-gray-300 group-hover:text-blue-500 transition-colors font-bold tracking-tight">Break on data chunks</span>
                                    </label>

                                    <div className="space-y-2">
                                        <label className="flex items-center gap-3 group cursor-pointer transition-all">
                                            <input
                                                type="radio"
                                                name="breakMode"
                                                checked={breakMode === 'bytes'}
                                                onChange={() => setBreakMode('bytes')}
                                                className="w-4 h-4 border-gray-300 text-blue-500 focus:ring-blue-500 dark:bg-[#1a1c20] dark:border-[#40444b]"
                                            />
                                            <span className="text-xs text-gray-700 dark:text-gray-300 group-hover:text-blue-500 transition-colors font-bold tracking-tight">Break after fixed length</span>
                                        </label>
                                        {breakMode === 'bytes' && (
                                            <div className="ml-7 flex items-center gap-2 animate-in fade-in duration-150">
                                                <input
                                                    type="number"
                                                    min={1}
                                                    value={breakAfterBytesCount}
                                                    onChange={(e) => setBreakAfterBytesCount(Math.max(1, Number(e.target.value)))}
                                                    className="w-20 bg-gray-50 dark:bg-[#1a1c20] border border-gray-200 dark:border-[#303339] rounded-lg px-2 py-1 text-xs text-gray-900 dark:text-gray-100 outline-none focus:ring-1 focus:ring-blue-500 shadow-inner transition-all"
                                                />
                                                <span className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">bytes</span>
                                            </div>
                                        )}
                                    </div>

                                    <div className="space-y-2">
                                        <label className="flex items-center gap-3 group cursor-pointer transition-all">
                                            <input
                                                type="radio"
                                                name="breakMode"
                                                checked={breakMode === 'timeout'}
                                                onChange={() => setBreakMode('timeout')}
                                                className="w-4 h-4 border-gray-300 text-blue-500 focus:ring-blue-500 dark:bg-[#1a1c20] dark:border-[#40444b]"
                                            />
                                            <span className="text-xs text-gray-700 dark:text-gray-300 group-hover:text-blue-500 transition-colors font-bold tracking-tight">Break after idle time</span>
                                        </label>
                                        {breakMode === 'timeout' && (
                                            <div className="ml-7 flex items-center gap-2 animate-in fade-in duration-150">
                                                <input
                                                    type="number"
                                                    value={breakAfterTimeoutMs}
                                                    onChange={(e) => setBreakAfterTimeoutMs(Number(e.target.value))}
                                                    className="w-20 bg-gray-50 dark:bg-[#1a1c20] border border-gray-200 dark:border-[#303339] rounded-lg px-2 py-1 text-xs text-gray-900 dark:text-gray-100 outline-none focus:ring-1 focus:ring-blue-500 shadow-inner transition-all"
                                                />
                                                <span className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">ms</span>
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* Sequence triggers: independent of the mode above, both can be
                                    active at once (or together with chunk/bytes/timeout) — one marks
                                    where a message starts, the other where it ends. */}
                                <div className="mt-4 pt-3 border-t border-gray-100 dark:border-[#2a2d33] space-y-3 pl-0.5">
                                    <div className="space-y-1">
                                        <label className="flex items-center gap-3 group cursor-pointer">
                                            <input
                                                type="checkbox"
                                                checked={breakBeforeSequenceEnabled}
                                                onChange={(e) => setBreakBeforeSequenceEnabled(e.target.checked)}
                                                className="w-4 h-4 rounded-md border-gray-300 text-blue-500 focus:ring-blue-500 dark:bg-[#1a1c20] dark:border-[#40444b] transition-all"
                                            />
                                            <span className="text-xs text-gray-700 dark:text-gray-300 group-hover:text-blue-500 transition-colors font-bold tracking-tight">Break before sequence</span>
                                        </label>
                                        <input
                                            type="text"
                                            value={breakBeforeSequenceValue}
                                            onChange={(e) => setBreakBeforeSequenceValue(e.target.value)}
                                            disabled={!breakBeforeSequenceEnabled}
                                            placeholder="e.g. \r\n, $A"
                                            className="ml-7 w-[calc(100%-1.75rem)] bg-gray-50 dark:bg-[#1a1c20] border border-gray-200 dark:border-[#303339] rounded-lg px-3 py-1.5 text-xs text-gray-900 dark:text-gray-100 outline-none focus:ring-1 focus:ring-blue-500 shadow-inner font-mono transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <label className="flex items-center gap-3 group cursor-pointer">
                                            <input
                                                type="checkbox"
                                                checked={breakAfterSequenceEnabled}
                                                onChange={(e) => setBreakAfterSequenceEnabled(e.target.checked)}
                                                className="w-4 h-4 rounded-md border-gray-300 text-blue-500 focus:ring-blue-500 dark:bg-[#1a1c20] dark:border-[#40444b] transition-all"
                                            />
                                            <span className="text-xs text-gray-700 dark:text-gray-300 group-hover:text-blue-500 transition-colors font-bold tracking-tight">Break after sequence</span>
                                        </label>
                                        <input
                                            type="text"
                                            value={breakAfterSequenceValue}
                                            onChange={(e) => setBreakAfterSequenceValue(e.target.value)}
                                            disabled={!breakAfterSequenceEnabled}
                                            placeholder="e.g. [END]"
                                            className="ml-7 w-[calc(100%-1.75rem)] bg-gray-50 dark:bg-[#1a1c20] border border-gray-200 dark:border-[#303339] rounded-lg px-3 py-1.5 text-xs text-gray-900 dark:text-gray-100 outline-none focus:ring-1 focus:ring-blue-500 shadow-inner font-mono transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                                        />
                                    </div>
                                </div>
                            </div>
                        </div>
                    </section>

                    {/* Logging */}
                    <section>
                        <h3 className="text-sm font-bold uppercase text-gray-500 dark:text-gray-400 mb-4 tracking-wider">Logging</h3>
                        <div className="space-y-4">
                            <div>
                                <label className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1.5 block">Log File Path</label>
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        value={logPath}
                                        onChange={(e) => setLogPath(e.target.value)}
                                        placeholder="path/to/log.txt"
                                        className="flex-grow bg-gray-50 dark:bg-[#1a1c20] border border-gray-200 dark:border-[#303339] rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-blue-500 transition-shadow"
                                    />
                                    <button
                                        onClick={handleBrowseLogPath}
                                        className="px-3 py-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg text-xs font-bold border border-gray-200 dark:border-[#303339] transition-colors"
                                    >
                                        Browse
                                    </button>
                                </div>
                            </div>

                            <button
                                onClick={() => setIsLogging(!isLogging)}
                                className={`w-full text-sm py-3 rounded-xl font-bold border transition-all duration-300 shadow-sm ${isLogging
                                    ? 'bg-red-500 hover:bg-red-600 text-white border-red-600 animate-pulse-slow'
                                    : 'bg-gray-50 dark:bg-[#1a1c20] text-gray-600 dark:text-gray-400 border-gray-200 dark:border-[#303339] hover:bg-gray-100 dark:hover:bg-gray-800'}`}
                            >
                                {isLogging ? '● LOGGING IN PROGRESS' : '○ START LOGGING'}
                            </button>
                        </div>
                    </section>

                    {/* Connection / Auto-Reconnect */}
                    <section>
                        <h3 className="text-sm font-bold uppercase text-gray-500 dark:text-gray-400 mb-4 tracking-wider">Connection</h3>
                        <div className="space-y-4">
                            <label className="flex items-center gap-3 group cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={autoReconnect}
                                    onChange={(e) => setAutoReconnect(e.target.checked)}
                                    className="w-4 h-4 rounded-md border-gray-300 text-amber-500 focus:ring-amber-500 dark:bg-[#1a1c20] dark:border-[#40444b] transition-all"
                                />
                                <div className="flex flex-col">
                                    <span className="text-xs font-bold text-gray-700 dark:text-gray-200 group-hover:text-amber-500 transition-colors">Auto-Reconnect</span>
                                    <span className="text-[10px] text-gray-400 dark:text-gray-500 italic">Automatically reconnect if port disconnects unexpectedly</span>
                                </div>
                            </label>

                            {autoReconnect && (
                                <div className="ml-7 space-y-3 animate-in fade-in duration-150">
                                    <Dropdown
                                        label="Max Timeout"
                                        value={reconnectTimeoutSec}
                                        direction="up"
                                        options={[
                                            { label: 'Indefinitely', value: 0 },
                                            { label: '30 seconds', value: 30 },
                                            { label: '1 minute', value: 60 },
                                            { label: '2 minutes', value: 120 },
                                            { label: '5 minutes', value: 300 },
                                        ]}
                                        onChange={setReconnectTimeoutSec}
                                    />
                                    <p className="text-[10px] text-gray-400 dark:text-gray-500 italic pl-1">
                                        Reconnects at ~200ms intervals via Rust (fast, low CPU)
                                    </p>
                                </div>
                            )}
                        </div>
                    </section>
                </div>

                {/* Footer */}
                <div className="px-6 py-4 border-t border-gray-100 dark:border-[#303339] bg-gray-50/50 dark:bg-[#2a2d33] flex justify-end">
                    <button
                        onClick={onClose}
                        className="px-6 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-sm font-bold transition-all shadow-lg shadow-blue-500/20 active:scale-95"
                    >
                        Done
                    </button>
                </div>
            </div>
        </div>
    );
}
