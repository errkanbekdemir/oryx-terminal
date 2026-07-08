import { useRef, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { LucideIcon } from 'lucide-react';

interface ContextMenuOption {
    label?: string;
    icon?: LucideIcon;
    onClick?: () => void;
    variant?: 'default' | 'danger';
    separator?: boolean;
}

interface ContextMenuProps {
    x: number;
    y: number;
    options: ContextMenuOption[];
    onClose: () => void;
}

export function ContextMenu({ x, y, options, onClose }: ContextMenuProps) {
    const menuRef = useRef<HTMLDivElement>(null);
    const [measured, setMeasured] = useState(false);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                onClose();
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [onClose]);

    // Ensure menu stays within viewport
    const [adjustedPos, setAdjustedPos] = useState({ x, y });

    useEffect(() => {
        if (menuRef.current) {
            const rect = menuRef.current.getBoundingClientRect();
            let newX = x;
            let newY = y;

            if (x + rect.width > window.innerWidth) {
                newX = window.innerWidth - rect.width - 10;
            }
            if (y + rect.height > window.innerHeight) {
                newY = window.innerHeight - rect.height - 10;
            }

            setAdjustedPos({ x: newX, y: newY });
            setMeasured(true);
        }
    }, [x, y]);

    // Rendered via a portal straight into <body> — keeping the menu's DOM nodes
    // out of the terminal's own subtree means they can never be swept into an
    // existing text selection there (a Selection Range's boundary is expressed
    // in terms of DOM tree position, so a sibling inserted into the selected
    // subtree can visually inherit the highlight even though it's unrelated).
    return createPortal(
        <div
            ref={menuRef}
            className={`fixed z-[300] min-w-[180px] select-none bg-white dark:bg-[#252526] border border-gray-200 dark:border-white/10 rounded-lg shadow-xl py-1 transition-opacity duration-75 ${measured ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
            style={{ left: adjustedPos.x, top: adjustedPos.y }}
        >
            {options.map((opt, idx) => {
                if (opt.separator) {
                    return <div key={`sep-${idx}`} className="h-px bg-gray-200 dark:bg-white/10 my-1 mx-2" />;
                }
                return (
                    <button
                        key={opt.label}
                        onClick={() => {
                            opt.onClick?.();
                            onClose();
                        }}
                        className={`w-full flex items-center gap-3 px-3 py-1.5 text-sm transition-colors hover:bg-gray-100 dark:hover:bg-white/5 ${opt.variant === 'danger'
                            ? 'text-red-500 hover:text-red-600'
                            : 'text-gray-700 dark:text-gray-300'
                            }`}
                    >
                        {opt.icon && <opt.icon size={16} className="opacity-70" />}
                        {opt.label}
                    </button>
                );
            })}
        </div>,
        document.body
    );
}
