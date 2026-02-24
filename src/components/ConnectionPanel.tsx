import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { RefreshCw, Play, Square, Settings as SettingsIcon, ChevronDown } from 'lucide-react';
import { useSettings } from '../contexts/SettingsContext';

interface SerialPortInfo {
    port_name: string;
    description: string;
}

interface ConnectionPanelProps {
    isConnected: boolean;
    isReconnecting: boolean;
    onConnect: (port: string, baud: number) => void;
    onDisconnect: () => void;
    onOpenSettings: () => void;
}

export function ConnectionPanel({
    isConnected, isReconnecting, onConnect, onDisconnect, onOpenSettings,
}: ConnectionPanelProps) {
    const { selectedPort, setSelectedPort } = useSettings();
    const selectedPortRef = useRef(selectedPort);

    // Update ref when selectedPort changes
    useEffect(() => {
        selectedPortRef.current = selectedPort;
    }, [selectedPort]);

    const [ports, setPorts] = useState<SerialPortInfo[]>([]);
    const [baudRate, setBaudRate] = useState<number>(() => {
        const saved = localStorage.getItem('oryx_baudRate');
        return saved ? Number(JSON.parse(saved)) : 115200;
    });
    const [baudInput, setBaudInput] = useState<string>('');
    const [loading, setLoading] = useState(false);
    const [isBaudOpen, setIsBaudOpen] = useState(false);
    const [isPortOpen, setIsPortOpen] = useState(false);

    useEffect(() => {
        localStorage.setItem('oryx_baudRate', JSON.stringify(baudRate));
        setBaudInput(String(baudRate));
    }, [baudRate]);

    const refreshPorts = async () => {
        setLoading(true);
        try {
            const availablePorts = await invoke<SerialPortInfo[]>('list_ports');
            setPorts(availablePorts);
            const portNames = availablePorts.map(p => p.port_name);
            if (!selectedPort && availablePorts.length > 0) {
                // No selection yet — auto-select first available
                setSelectedPort(availablePorts[0].port_name);
            } else if (selectedPort && !portNames.includes(selectedPort)) {
                // Persisted port is no longer available — clear selection
                setSelectedPort('');
            }
        } catch (error) {
            console.error('Failed to list ports:', error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        refreshPorts();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Auto port refresh when not connected or reconnecting
    useEffect(() => {
        if (isConnected || isReconnecting) return; // Don't refresh while connected or reconnecting

        const interval = setInterval(async () => {
            try {
                const availablePorts = await invoke<SerialPortInfo[]>('list_ports');
                const portNames = availablePorts.map(p => p.port_name);

                setPorts(prevPorts => {
                    const prevNames = prevPorts.map(p => p.port_name).sort().join(',');
                    const newNames = portNames.slice().sort().join(',');
                    // Only update if port list has changed
                    if (prevNames !== newNames) {
                        // Auto-selection logic
                        const currentSelection = selectedPortRef.current;
                        if (!currentSelection && availablePorts.length > 0) {
                            setSelectedPort(availablePorts[0].port_name);
                        } else if (currentSelection && !portNames.includes(currentSelection)) {
                            setSelectedPort('');
                        }
                        return availablePorts;
                    }
                    return prevPorts;
                });
            } catch {
                // Silently fail on error
            }
        }, 2000); // Check every 2 seconds

        return () => clearInterval(interval);
    }, [isConnected, setSelectedPort]); // eslint-disable-line react-hooks/exhaustive-deps

    return (
        <div className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-6 px-6 py-4 bg-white/70 dark:bg-[#2b2d31]/70 backdrop-blur-xl border-b border-gray-200/50 dark:border-white/5 shadow-[0_4px_20px_-5px_rgba(0,0,0,0.1)] animate-toolbar transition-all duration-300 select-none">

            {/* SETTINGS GROUP (LEFT) */}
            <div className="flex items-center gap-6">
                {/* Port Selection - Custom Dropdown */}
                <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-bold text-gray-600 dark:text-gray-400 uppercase tracking-wide ml-1">Serial Port</label>
                    <div className="relative">
                        {/* Trigger Box */}
                        <div
                            onClick={() => !(isConnected || isReconnecting) && setIsPortOpen(!isPortOpen)}
                            className={`w-full bg-white dark:bg-[#1a1c20] border border-gray-300 dark:border-gray-700 rounded-lg pl-4 pr-12 py-2.5 text-sm font-bold text-gray-900 dark:text-white cursor-pointer min-w-[280px] shadow-sm hover:border-gray-400 dark:hover:border-gray-600 transition-all ${(isConnected || isReconnecting) ? 'opacity-60 cursor-not-allowed' : ''} flex items-center h-[42px]`}
                        >
                            {selectedPort ? (
                                <div className="flex flex-col">
                                    <span className="leading-none">{selectedPort}</span>
                                    <span className="text-xs font-normal text-gray-500 dark:text-gray-400 mt-0.5">
                                        {ports.find(p => p.port_name === selectedPort)?.description || 'Unknown Device'}
                                    </span>
                                </div>
                            ) : (
                                <span className="text-gray-400 font-normal">Select Port...</span>
                            )}
                        </div>

                        {/* Refresh Button */}
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                refreshPorts();
                            }}
                            disabled={isConnected || isReconnecting || loading}
                            className="group absolute right-3 top-1/2 -translate-y-1/2 p-1.5 hover:bg-gray-100 dark:hover:bg-white/10 rounded-md transition-all text-gray-500 hover:text-blue-600 dark:text-gray-400 disabled:opacity-30 z-10"
                            title="Refresh Ports"
                        >
                            <RefreshCw size={14} className={loading ? 'animate-spin' : 'transition-transform group-hover:rotate-180 duration-500'} />
                        </button>

                        {/* Dropdown Menu */}
                        {isPortOpen && !(isConnected || isReconnecting) && (
                            <>
                                <div
                                    className="fixed inset-0 z-40"
                                    onClick={() => setIsPortOpen(false)}
                                />
                                <ul className="absolute top-full left-0 mt-1 w-full bg-white dark:bg-[#1a1c20] border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl max-h-[240px] overflow-y-auto z-50 py-1">
                                    {ports.length === 0 ? (
                                        <li className="px-4 py-2 text-sm text-gray-400 italic">No ports found</li>
                                    ) : (
                                        ports.map((port) => (
                                            <li
                                                key={port.port_name}
                                                onClick={() => {
                                                    setSelectedPort(port.port_name);
                                                    setIsPortOpen(false);
                                                }}
                                                className={`px-4 py-2 text-sm font-medium cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/20 text-gray-700 dark:text-gray-200 ${selectedPort === port.port_name ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' : ''}`}
                                            >
                                                <div className="flex flex-col">
                                                    <span className="font-medium">{port.port_name}</span>
                                                    <span className="text-xs text-gray-500 dark:text-gray-400 font-normal">{port.description}</span>
                                                </div>
                                            </li>
                                        ))
                                    )}
                                </ul>
                            </>
                        )}
                    </div>
                </div>

                {/* Baud Rate Selection - Editable Combobox */}
                <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-bold text-gray-600 dark:text-gray-400 uppercase tracking-wide ml-1">Baud Rate</label>
                    <div className="relative">
                        <input
                            type="number"
                            value={baudInput}
                            onChange={(e) => {
                                const val = e.target.value;
                                setBaudInput(val);
                                if (val && !isNaN(Number(val))) {
                                    setBaudRate(Number(val));
                                }
                            }}
                            onBlur={() => {
                                if (!baudInput || isNaN(Number(baudInput))) {
                                    setBaudInput(String(baudRate));
                                }
                            }}
                            disabled={isConnected || isReconnecting}
                            className="w-[140px] bg-white dark:bg-[#1a1c20] border border-gray-300 dark:border-gray-700 rounded-lg pl-4 pr-8 py-2.5 text-sm font-bold text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all shadow-sm hover:border-gray-400 dark:hover:border-gray-600 appearance-none [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:hidden [&::-webkit-inner-spin-button]:hidden [-moz-appearance:textfield]"
                        />

                        {/* Dropdown Toggle */}
                        <button
                            onClick={() => !(isConnected || isReconnecting) && setIsBaudOpen(!isBaudOpen)}
                            disabled={isConnected || isReconnecting}
                            className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 text-gray-500 dark:text-gray-400 hover:text-blue-500 hover:bg-gray-100 dark:hover:bg-white/10 rounded-md transition-all cursor-pointer disabled:opacity-50"
                        >
                            <ChevronDown size={14} />
                        </button>

                        {/* Dropdown List */}
                        {isBaudOpen && (
                            <>
                                <div
                                    className="fixed inset-0 z-40"
                                    onClick={() => setIsBaudOpen(false)}
                                />
                                <ul className="absolute top-full left-0 mt-1 w-full bg-white dark:bg-[#1a1c20] border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl max-h-[200px] overflow-y-auto z-50 py-1">
                                    {[9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].map((rate) => (
                                        <li
                                            key={rate}
                                            onClick={() => {
                                                setBaudRate(rate);
                                                setIsBaudOpen(false);
                                            }}
                                            className={`px-4 py-2 text-sm font-medium cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/20 text-gray-700 dark:text-gray-200 ${baudRate === rate ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' : ''}`}
                                        >
                                            {rate}
                                        </li>
                                    ))}
                                </ul>
                            </>
                        )}
                    </div>
                </div>
            </div>

            {/* ACTIONS GROUP (RIGHT) */}
            <div className="flex items-center gap-4">
                <button
                    onClick={onOpenSettings}
                    className="group flex flex-col items-center gap-1 p-2 text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 transition-all rounded-xl hover:bg-blue-500/10"
                    title="Advanced Settings"
                >
                    <SettingsIcon size={20} className="transition-transform group-hover:rotate-45" />
                    <span className="text-[9px] uppercase font-bold tracking-tighter">Settings</span>
                </button>

                <button
                    onClick={() => (isConnected || isReconnecting) ? onDisconnect() : onConnect(selectedPort, baudRate)}
                    disabled={!selectedPort && !isConnected && !isReconnecting}
                    className={`relative flex items-center gap-3 px-6 py-2.5 rounded-xl font-bold text-sm shadow-lg transition-all transform active:scale-95 overflow-hidden group/btn ${isReconnecting
                            ? 'bg-amber-500 hover:bg-amber-600 text-white shadow-amber-500/20'
                            : isConnected
                                ? 'bg-red-500 hover:bg-red-600 text-white shadow-red-500/20'
                                : 'bg-blue-600 hover:bg-blue-700 text-white shadow-blue-600/20 disabled:opacity-50 disabled:grayscale disabled:cursor-not-allowed'
                        }`}
                >
                    <div className="absolute inset-0 bg-white/10 translate-y-full group-hover/btn:translate-y-0 transition-transform duration-300" />
                    {isReconnecting
                        ? <RefreshCw size={16} className="animate-spin" />
                        : isConnected
                            ? <Square size={16} fill="white" strokeWidth={0} />
                            : <Play size={16} fill="white" strokeWidth={0} />
                    }
                    <span className="relative">
                        {isReconnecting ? 'Stop Reconnecting' : isConnected ? 'Disconnect' : 'Connect'}
                    </span>
                </button>
            </div>
        </div>
    );
}
