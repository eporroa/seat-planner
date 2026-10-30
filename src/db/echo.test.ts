import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { runLocalMigrations } from "./migrate";

const ROOM = "r";
const T1 = "00000000-0000-4000-8000-000000000001";
const SYNCED_TABLE = `INSERT INTO tables_synced (id, room_id, label, shape, pos_x, pos_y, seat_limit, shape_radius, last_mutation_id)
  VALUES ('${T1}', '${ROOM}', 'Mesa 1', 'circular', 140, 120, 8, 60, $1)
  ON CONFLICT (id) DO UPDATE SET pos_x = EXCLUDED.pos_x, pos_y = EXCLUDED.pos_y, last_mutation_id = EXCLUDED.last_mutation_id`;

let pg: PGlite;

async function overlay() {
  return (await pg.query<{ mutation_id: string }>("SELECT mutation_id FROM tables_local")).rows;
}
async function outbox() {
  return (await pg.query<{ mutation_id: string }>("SELECT mutation_id FROM outbox")).rows;
}

beforeEach(async () => {
  pg = await PGlite.create();
  await runLocalMigrations(pg);
  await pg.exec("INSERT INTO profile (client_id, name, base_name, is_admin) VALUES (gen_random_uuid(), 'Admin', 'Admin', true)");
  await pg.query(SYNCED_TABLE, [null]);
});

describe("echo cleanup (same statements the changes feed applies)", () => {
  it("clears overlay and outbox when the echo carries the same mutation id", async () => {
    await pg.exec(`UPDATE floor_tables SET pos_x = 200 WHERE id = '${T1}'`);
    const [mine] = await overlay();
    expect(await outbox()).toHaveLength(1);
    expect((await pg.query<{ is_pending: boolean }>("SELECT is_pending FROM floor_tables")).rows[0]?.is_pending).toBe(true);

    // The server applied it and the shape streams the row back.
    await pg.transaction(async (tx) => {
      await tx.query(SYNCED_TABLE.replace("140, 120", "200, 120"), [mine!.mutation_id]);
    });
    expect(await overlay()).toHaveLength(0);
    expect(await outbox()).toHaveLength(0);
    expect((await pg.query<{ pos_x: number }>("SELECT pos_x FROM floor_tables")).rows[0]?.pos_x).toBe(200);
  });

  it("keeps the overlay when the echo belongs to an older mutation", async () => {
    await pg.exec(`UPDATE floor_tables SET pos_x = 200 WHERE id = '${T1}'`);
    const [first] = await overlay();
    await pg.exec(`UPDATE floor_tables SET pos_x = 260 WHERE id = '${T1}'`);
    const [second] = await overlay();
    expect(second!.mutation_id).not.toBe(first!.mutation_id);

    await pg.query(SYNCED_TABLE.replace("140, 120", "200, 120"), [first!.mutation_id]);
    expect(await overlay()).toHaveLength(1); // newer local change still pending
    expect((await pg.query<{ pos_x: number }>("SELECT pos_x FROM floor_tables")).rows[0]?.pos_x).toBe(260);
    // The older mutation's outbox row is gone; the newer one remains.
    expect((await outbox()).map((r) => r.mutation_id)).toEqual([second!.mutation_id]);
  });

  it("clears a delete tombstone when the server's DELETE arrives (by primary key)", async () => {
    await pg.exec(`DELETE FROM floor_tables WHERE id = '${T1}'`);
    expect((await pg.query("SELECT * FROM floor_tables")).rows).toHaveLength(0);
    expect(await overlay()).toHaveLength(1);

    await pg.exec(`DELETE FROM tables_synced WHERE id = '${T1}'`);
    expect(await overlay()).toHaveLength(0);
    expect(await outbox()).toHaveLength(0);
  });

  it("claims of a locally deleted table disappear from the view", async () => {
    await pg.exec(`INSERT INTO floor_seat_claims (table_id, seat_index) VALUES ('${T1}', 3)`);
    expect((await pg.query("SELECT * FROM floor_seat_claims")).rows).toHaveLength(1);
    await pg.exec(`DELETE FROM floor_tables WHERE id = '${T1}'`);
    expect((await pg.query("SELECT * FROM floor_seat_claims")).rows).toHaveLength(0);
  });

  it("a refetch clears synced rows without dropping local tombstones", async () => {
    await pg.exec(`DELETE FROM floor_tables WHERE id = '${T1}'`);
    await pg.transaction(async (tx) => {
      await tx.exec("SET LOCAL session_replication_role = replica");
      await tx.exec("DELETE FROM tables_synced");
      await tx.exec("SET LOCAL session_replication_role = origin");
    });
    expect(await overlay()).toHaveLength(1);
    expect(await outbox()).toHaveLength(1);
  });
});
