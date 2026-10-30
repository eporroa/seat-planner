import { worker } from "@electric-sql/pglite/worker";
import { runLocalMigrations } from "./migrate";
import { createFlusher } from "./flusher";
import { createSyncController } from "./sync-controller";
import { openDatabase } from "./storage";
import { parseStorageMode } from "./storage-mode";

// Only the leader tab runs this init; other tabs query through it.
worker({
  async init() {
    // The main thread passes the ?storage= test switch through the worker's name.
    const { pg, backend } = await openDatabase(parseStorageMode(self.name.replace(/^storage:/, "")));
    await runLocalMigrations(pg);
    await pg.query(
      "INSERT INTO local_meta (key, value) VALUES ('backend', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [backend]
    );
    // A previous leader may have died mid-flight; the server dedupes by mutation_id.
    await pg.exec("UPDATE outbox SET status = 'pending' WHERE status = 'inflight'");
    // Not awaited past subscription: the UI must never wait for the network.
    const sync = createSyncController(pg);
    sync.init().catch((error) => console.error("[sync] init failed", error));
    createFlusher(pg, { refetch: sync.refetch })
      .init()
      .catch((error) => console.error("[flusher] init failed", error));
    return pg;
  },
});
