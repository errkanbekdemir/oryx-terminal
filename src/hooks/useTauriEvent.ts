import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';

/**
 * Subscribes to a Tauri backend event with safe React cleanup.
 *
 * React StrictMode double-invokes effects in development. Because Tauri's
 * listen() is async, the standard `unlisten.then(f => f())` cleanup leaves a
 * stale listener registered until the Promise resolves — causing the handler
 * to fire twice for every event during that window.
 *
 * This hook fixes the race by tracking a `cancelled` flag synchronously in
 * cleanup. When the Promise resolves it either stores the unlisten fn (normal
 * path) or calls it immediately (already unmounted path), so the stale
 * listener is deregistered from Tauri as soon as possible rather than just
 * becoming a no-op.
 */
export function useTauriEvent<T>(
  event: string,
  handler: (payload: T) => void,
): void {
  // Keep handler in a ref so the effect closure never goes stale —
  // the effect only needs to re-run if the event name itself changes.
  const handlerRef = useRef(handler);
  useEffect(() => { handlerRef.current = handler; });

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    listen<T>(event, (e) => handlerRef.current(e.payload)).then((f) => {
      if (cancelled) {
        f(); // already unmounted — deregister from Tauri immediately
      } else {
        unlisten = f;
      }
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [event]);
}
