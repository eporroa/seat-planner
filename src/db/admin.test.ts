import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { createFlusher } from "./flusher";
import { runLocalMigrations } from "./migrate";

const T1 = "00000000-0000-4000-8000-000000000001";
const T2 = "00000000-0000-4000-8000-000000000002";
const CLIENT = "11111111-1111-4111-8111-111111111111";
let pg: PGlite;

async function setup(isAdmin: boolean) {
  pg = await PGlite.create();
  await runLocalMigrations(pg);
  await pg.exec(`INSERT INTO profile (client_id, name, base_name, registered_base, is_admin)
    VALUES ('${CLIENT}', 'Admin', 'Admin', 'Admin', ${isAdmin})`);
  await pg.exec(`INSERT INTO rooms_synced (id) VALUES ('r')`);
  await pg.exec(`INSERT INTO tables_synced (id, room_id, label, shape, pos_x, pos_y, seat_limit, shape_radius) VALUES
    ('${T1}', 'r', 'Mesa 1', 'circular', 140, 120, 8, 60),
    ('${T2}', 'r', 'Mesa 2', 'circular', 540, 120, 8, 60)`);
}
const outbox = async () => (await pg.query<{ entity: string; op: string; payload: any }>("SELECT entity, op, payload FROM outbox ORDER BY created_at")).rows;

describe("admin batch + reset (local)", () => {
  beforeEach(() => setup(true));

  it("moves several tables under ONE mutation and one outbox row", async () => {
    await pg.query("SELECT local_move_tables($1::jsonb)", [JSON.stringify([{ id: T1, pos_x: 200, pos_y: 120 }, { id: T2, pos_x: 600, pos_y: 120 }])]);
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity: "table", op: "batch_update" });
    expect(rows[0]?.payload.tables).toHaveLength(2);
    const view = await pg.query<{ id: string; pos_x: number; is_pending: boolean }>("SELECT id, pos_x, is_pending FROM floor_tables ORDER BY id");
    expect(view.rows.map((r) => [r.pos_x, r.is_pending])).toEqual([[200, true], [600, true]]);
    const ids = await pg.query<{ n: number }>("SELECT count(DISTINCT mutation_id)::int AS n FROM tables_local");
    expect(ids.rows[0]?.n).toBe(1);
  });

  it("each table's echo clears its own overlay; the outbox row goes with the first", async () => {
    await pg.query("SELECT local_move_tables($1::jsonb)", [JSON.stringify([{ id: T1, pos_x: 200, pos_y: 120 }, { id: T2, pos_x: 600, pos_y: 120 }])]);
    const m = (await pg.query<{ mutation_id: string }>("SELECT mutation_id FROM outbox")).rows[0]?.mutation_id;
    await pg.query("UPDATE tables_synced SET pos_x = 200, last_mutation_id = $1 WHERE id = $2", [m, T1]);
    expect((await pg.query("SELECT * FROM tables_local")).rows).toHaveLength(1);
    expect(await outbox()).toHaveLength(0);
    await pg.query("UPDATE tables_synced SET pos_x = 600, last_mutation_id = $1 WHERE id = $2", [m, T2]);
    expect((await pg.query("SELECT * FROM tables_local")).rows).toHaveLength(0);
  });

  it("queues a reset with no optimistic state", async () => {
    await pg.exec("SELECT local_reset_room()");
    expect(await outbox()).toMatchObject([{ entity: "room", op: "reset" }]);
    expect((await pg.query("SELECT * FROM tables_local")).rows).toHaveLength(0);
  });

  it("creates, renames and resizes tables as an admin", async () => {
    await pg.exec(`INSERT INTO floor_tables (id, room_id, label, shape, pos_x, pos_y, seat_limit, shape_width, shape_height)
      VALUES (gen_random_uuid(), 'r', 'Nueva', 'rectangular', 900, 600, 10, 200, 80)`);
    await pg.exec(`UPDATE floor_tables SET label = 'VIP', shape_radius = 80 WHERE id = '${T1}'`);
    expect((await outbox()).map((r) => `${r.entity}/${r.op}`)).toEqual(["table/insert", "table/update"]);
  });
});

describe("admin batch + reset (attendee)", () => {
  beforeEach(() => setup(false));

  it("cannot batch-move or reset", async () => {
    await expect(pg.query("SELECT local_move_tables($1::jsonb)", [JSON.stringify([{ id: T1, pos_x: 200, pos_y: 120 }])])).rejects.toThrow(/admin/);
    await expect(pg.exec("SELECT local_reset_room()")).rejects.toThrow(/admin/);
    expect(await outbox()).toHaveLength(0);
  });
});

describe("rejection log", () => {
  beforeEach(() => setup(false));

  it("keeps the last 20 rejections", async () => {
    // Claim then release the same chair: every step is its own mutation.
    for (let i = 0; i < 12; i++) {
      const seat = (i % 8) + 1;
      await pg.exec(`INSERT INTO floor_seat_claims (table_id, seat_index) VALUES ('${T1}', ${seat})`);
      await pg.exec(`DELETE FROM floor_seat_claims WHERE table_id = '${T1}' AND seat_index = ${seat}`);
    }
    const flusher = createFlusher(pg, {
      origin: "http://x",
      fetchFn: async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        return Response.json({
          results: body.mutations.map((m: any) => ({ mutationId: m.mutation_id, status: "rejected", reason: "seat_taken" })),
        });
      },
    });
    await flusher.flush();
    await flusher.flush();
    const log = await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM rejection_log");
    expect(log.rows[0]?.n).toBe(20);
  });
});
