// Kept apart from storage.ts so the main thread can read the test switch without
// importing PGlite (which must only ever run in the worker).
export type StorageMode = "auto" | "idb" | "opfs-broken";

export function parseStorageMode(value: string | null | undefined): StorageMode {
  return value === "idb" || value === "opfs-broken" ? value : "auto";
}
