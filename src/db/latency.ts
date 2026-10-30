import { useSyncExternalStore } from "react";

// Honest latency readout: from the start of a local write to the next render
// of the live queries that follows it. Never a hardcoded number.
let startedAt: number | null = null;
let last: number | null = null;
const listeners = new Set<() => void>();

export function beginWrite(): void {
  startedAt = performance.now();
}

export function cancelWrite(): void {
  startedAt = null;
}

// Called after the live-query results have rendered.
export function noteRender(): void {
  if (startedAt === null) return;
  last = performance.now() - startedAt;
  startedAt = null;
  listeners.forEach((l) => l());
}

export function useLastWriteLatency(): number | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => last,
    () => null
  );
}
