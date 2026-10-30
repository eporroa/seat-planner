import type { PGlite } from "@electric-sql/pglite";
import { LOCAL_MIGRATIONS } from "./migrations";

// Runs pending versioned migrations, each in its own transaction.
export async function runLocalMigrations(pg: PGlite): Promise<void> {
  await pg.exec("CREATE TABLE IF NOT EXISTS local_migrations (version integer PRIMARY KEY)");
  const applied = await pg.query<{ version: number }>("SELECT version FROM local_migrations");
  const done = new Set(applied.rows.map((r) => r.version));
  for (const migration of LOCAL_MIGRATIONS) {
    if (done.has(migration.version)) continue;
    await pg.transaction(async (tx) => {
      await tx.exec(migration.sql);
      await tx.query("INSERT INTO local_migrations (version) VALUES ($1)", [migration.version]);
    });
  }
}
