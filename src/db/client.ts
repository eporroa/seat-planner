import { PGliteWorker } from "@electric-sql/pglite/worker";
import { live, type PGliteWithLive } from "@electric-sql/pglite/live";
import { parseStorageMode } from "./storage-mode";

export type AppDb = PGliteWorker & PGliteWithLive;

let dbPromise: Promise<AppDb> | null = null;

// Browser only. One PGliteWorker per tab; leader election happens inside it.
export function getDb(): Promise<AppDb> {
  // ?storage=idb skips OPFS and ?storage=opfs-broken makes it fail like Safari does: for testing.
  const storage = parseStorageMode(new URLSearchParams(location.search).get("storage"));
  dbPromise ??= PGliteWorker.create(
    new Worker(new URL("./pglite.worker.ts", import.meta.url), { type: "module", name: `storage:${storage}` }),
    { extensions: { live } }
  ) as Promise<AppDb>;
  return dbPromise;
}
