import { PGlite } from "@electric-sql/pglite";

import type { StorageMode } from "./storage-mode";

// Where the local database lives. OPFS is preferred; IndexedDB is the fallback
// (and what Safari ends up with when it refuses OPFS sync access handles).

const DB_NAME = "mesas-en-vivo";
const OPFS_ATTEMPTS = 3;
const OPFS_RETRY_MS = 400;
const OPFS_TIMEOUT_MS = 30_000; // a cold first start (initdb) can take several seconds
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The browser refused OPFS outright (as opposed to a transient lock): retrying won't help.
class OpfsRefusedError extends Error {}

// PGlite opens its OPFS files inside `new Promise(async …)` executors, so when the
// browser refuses a handle (Safari: "UnknownError: Invalid platform file handle")
// create() never settles and the error only surfaces as an unhandled rejection.
// Catching that event is the only way to notice, and to fall back instead of hanging.
function createOpfs(): Promise<PGlite> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (then: () => void) => {
      if (settled) return;
      settled = true;
      self.removeEventListener("unhandledrejection", onRejection);
      clearTimeout(timer);
      then();
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      event.preventDefault();
      const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
      finish(() => reject(new OpfsRefusedError(reason)));
    };
    const timer = setTimeout(() => finish(() => reject(new OpfsRefusedError("OPFS did not finish opening"))), OPFS_TIMEOUT_MS);
    self.addEventListener("unhandledrejection", onRejection);
    PGlite.create(`opfs-ahp://${DB_NAME}`).then(
      (pg) => finish(() => resolve(pg)),
      (error) => finish(() => reject(error))
    );
  });
}

// Test switch (?storage=opfs-broken): fail exactly the way Safari does.
function simulateSafariRefusal() {
  FileSystemFileHandle.prototype.createSyncAccessHandle = () =>
    Promise.reject(new DOMException("Invalid platform file handle", "UnknownError"));
}

export async function openDatabase(mode: StorageMode): Promise<{ pg: PGlite; backend: "opfs-ahp" | "idb" }> {
  if (mode === "opfs-broken") simulateSafariRefusal();

  if (mode !== "idb") {
    // A reload can reach the new worker while the old one still holds the OPFS
    // handles. Falling back to IndexedDB at that moment would silently fork the
    // local data (profile, pending outbox), so a transient failure is retried.
    for (let attempt = 0; attempt < OPFS_ATTEMPTS; attempt++) {
      try {
        return { pg: await createOpfs(), backend: "opfs-ahp" };
      } catch (error) {
        if (error instanceof OpfsRefusedError) {
          console.warn("[pglite] the browser refused OPFS, using IndexedDB:", error.message);
          break;
        }
        await sleep(OPFS_RETRY_MS);
      }
    }
  }
  return { pg: await PGlite.create(`idb://${DB_NAME}`), backend: "idb" };
}
