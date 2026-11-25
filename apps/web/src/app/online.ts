import { useSyncExternalStore } from 'react';

/**
 * Whether the server answers (design 52): set by every query result, so the notice
 * appears when requests fail with a network error and clears by itself on the next
 * successful poll (D52).
 */
let offline = false;
const listeners = new Set<() => void>();

export function setOffline(value: boolean): void {
  if (value === offline) return;
  offline = value;
  for (const l of listeners) l();
}

export function useOffline(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => offline,
  );
}
