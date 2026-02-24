import { Command, Sun, Moon, Settings as SettingsIcon, Trash2, RefreshCw, FileText } from 'lucide-react';
import { Dropdown } from './Dropdown';
import { useSettings } from '../contexts/SettingsContext';

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

    const getConfigShorthand = () => {
        const p = parity.toLowerCase().charAt(0).toUpperCase() || 'N';
        return `${dataBits}${p}${stopBits}`;
    };

    const getFlowControlLabel = () => {
        const fc = flowControl.toLowerCase();
        if (fc === 'hardware') return 'HW';
        if (fc === 'software') return 'SW';
        return 'None';
    };

    return (
        <div className="flex items-center justify-between px-4 h-9 bg-white dark:bg-[#1a1c20] border-t border-gray-200 dark:border-[#303339] text-gray-600 dark:text-gray-400 select-none z-30 transition-colors duration-200">
            {/* Left side: Connection & Serial Config */}
            <div className="flex items-center gap-3">
                {/* Status Pill */}
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

                <div className="h-4 w-px bg-gray-200 dark:bg-gray-800" />

                {/* Configuration Badges */}
                <div className="flex items-center gap-1.5">
                    <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-blue-500/5 dark:bg-blue-500/10 border border-blue-200/50 dark:border-blue-900/20">
                        <span className="text-[10px] font-bold text-blue-700 dark:text-blue-400 leading-none">
                            {getConfigShorthand()}
                        </span>
                        <div className="w-px h-2 bg-blue-200 dark:bg-blue-800" />
                        <span className="text-[10px] font-bold text-blue-600 dark:text-blue-500 leading-none flex items-center gap-1">
                            <span className="opacity-50 font-normal">FC:</span> {getFlowControlLabel()}
                        </span>
                    </div>
                </div>

                <div className="h-4 w-px bg-gray-200 dark:bg-gray-800" />

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
            </div>

            {/* Right side: App Controls */}
            <div className="flex items-center gap-1">
                {/* Logging Toggle */}
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

                <div className="h-3 w-px bg-gray-200 dark:bg-gray-800 mx-1" />

                {/* Clear Terminal Button */}
                <button
                    onClick={onClear}
                    className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-white/5 text-gray-500 dark:text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-all active:scale-90"
                    title="Clear Terminal (Ctrl+L)"
                >
                    <Trash2 size={14} />
                </button>

                <div className="h-3 w-px bg-gray-200 dark:bg-gray-800 mx-0.5" />

                {/* AutoScroll Toggle */}
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

                <div className="h-3 w-px bg-gray-200 dark:bg-gray-800 mx-1" />

                {/* Macro Toggle */}
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

                <div className="h-3 w-px bg-gray-200 dark:bg-gray-800 mx-1" />

                {/* Settings Toggle */}
                <button
                    onClick={onOpenSettings}
                    className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-white/5 text-gray-500 dark:text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 transition-all active:scale-90"
                    title="Settings"
                >
                    <SettingsIcon size={14} />
                </button>

                <div className="h-3 w-px bg-gray-200 dark:bg-gray-800 mx-0.5" />

                {/* Help Button */}
                <button
                    onClick={onOpenHelp}
                    className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-white/5 text-gray-500 dark:text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 transition-all active:scale-90 font-bold text-xs w-6 h-6 flex items-center justify-center"
                    title="Keyboard Shortcuts (?)"
                >
                    ?
                </button>

                <div className="h-3 w-px bg-gray-200 dark:bg-gray-800 mx-0.5" />

                {/* Theme Toggle */}
                <button
                    onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                    className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-white/5 text-gray-500 dark:text-gray-400 hover:text-amber-500 dark:hover:text-amber-400 transition-all hover:rotate-12 active:rotate-45 duration-300"
                    title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
                >
                    {theme === 'dark' ? <Moon size={14} className="transition-all duration-300 rotate-12" /> : <Sun size={14} className="transition-all duration-300 -rotate-12" />}
                </button>
            </div>
        </div>
    );
}
