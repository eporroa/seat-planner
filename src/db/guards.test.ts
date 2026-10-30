import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { runLocalMigrations } from "./migrate";

const T1 = "00000000-0000-4000-8000-000000000001";
const OTHER_TAG = "ffffffffffffffffffffffffffffffff";
const BIG_TABLES = [
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
];
let pg: PGlite;

async function setup(isAdmin: boolean) {
  pg = await PGlite.create();
  await runLocalMigrations(pg);
  await pg.exec(`INSERT INTO profile (client_id, name, base_name, is_admin)
    VALUES (gen_random_uuid(), 'JaguarCoral', 'JaguarCoral', ${isAdmin})`);
  await pg.exec(`INSERT INTO rooms_synced (id, is_locked) VALUES ('r', false)`);
  await pg.exec(`INSERT INTO tables_synced (id, room_id, label, shape, pos_x, pos_y, seat_limit, shape_radius)
    VALUES ('${T1}', 'r', 'Mesa 1', 'circular', 140, 120, 4, 60)`);
  // Three more tables with 10 chairs each, for the 20-chair limit.
  for (const [n, id] of BIG_TABLES.entries()) {
    await pg.exec(`INSERT INTO tables_synced (id, room_id, label, shape, pos_x, pos_y, seat_limit, shape_radius)
      VALUES ('${id}', 'r', 'Mesa ${n + 2}', 'circular', ${540 + n * 400}, 120, 10, 60)`);
  }
}

// The i-th chair (1-based) counting through the three big tables.
const nthSeat = (i: number) => ({ table: BIG_TABLES[Math.floor((i - 1) / 10)]!, seat: ((i - 1) % 10) + 1 });
const claim = (i: number) => pg.exec(`INSERT INTO floor_seat_claims (table_id, seat_index) VALUES ('${nthSeat(i).table}', ${nthSeat(i).seat})`);
const held = async () => (await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM floor_seat_claims WHERE owner_tag = md5((SELECT client_id::text FROM profile))")).rows[0]?.n;
const outboxCount = async () => (await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM outbox")).rows[0]?.n;

describe("attendee guards", () => {
  beforeEach(() => setup(false));

  it("can move a table and add a chair, writing overlay + outbox together", async () => {
    await pg.exec(`UPDATE floor_tables SET pos_x = 200 WHERE id = '${T1}'`);
    await pg.exec(`UPDATE floor_tables SET seat_limit = 5 WHERE id = '${T1}'`);
    expect(await outboxCount()).toBe(2);
  });

  it.each([
    ["delete a table", `DELETE FROM floor_tables WHERE id = '${T1}'`, /admin/],
    ["rename a table", `UPDATE floor_tables SET label = 'X' WHERE id = '${T1}'`, /admin/],
    ["resize a table", `UPDATE floor_tables SET shape_radius = 80 WHERE id = '${T1}'`, /admin/],
    ["remove a chair", `UPDATE floor_tables SET seat_limit = 3 WHERE id = '${T1}'`, /quitar/],
    ["lock the room", `UPDATE floor_room SET is_locked = true`, /admin/],
  ])("cannot %s", async (_name, sql, message) => {
    await expect(pg.exec(sql)).rejects.toThrow(message);
    expect(await outboxCount()).toBe(0);
  });

  it("cannot move tables or add chairs while the room is locked", async () => {
    await pg.exec("UPDATE rooms_synced SET is_locked = true");
    await expect(pg.exec(`UPDATE floor_tables SET pos_x = 200 WHERE id = '${T1}'`)).rejects.toThrow(/bloqueado/);
    await expect(pg.exec(`UPDATE floor_tables SET seat_limit = 5 WHERE id = '${T1}'`)).rejects.toThrow(/bloqueado/);
  });

  it("holds several chairs: claiming another does not release the first", async () => {
    await pg.exec(`INSERT INTO floor_seat_claims (table_id, seat_index) VALUES ('${T1}', 1)`);
    await pg.exec(`INSERT INTO floor_seat_claims (table_id, seat_index) VALUES ('${T1}', 2)`);
    const claims = await pg.query<{ seat_index: number }>("SELECT seat_index FROM floor_seat_claims ORDER BY seat_index");
    expect(claims.rows.map((r) => r.seat_index)).toEqual([1, 2]);
    expect(await outboxCount()).toBe(2);
  });

  it("claiming a chair I already hold changes nothing", async () => {
    await pg.exec(`INSERT INTO floor_seat_claims (table_id, seat_index) VALUES ('${T1}', 1)`);
    await pg.exec(`INSERT INTO floor_seat_claims (table_id, seat_index) VALUES ('${T1}', 1)`);
    expect(await outboxCount()).toBe(1);
  });

  it("holds up to 20 chairs, then the 21st releases the OLDEST under the same mutation", async () => {
    for (let i = 1; i <= 20; i++) await claim(i);
    expect(await held()).toBe(20);
    expect(await outboxCount()).toBe(20);

    await claim(21);
    expect(await held()).toBe(20);
    const seats = (await pg.query<{ table_id: string; seat_index: number }>("SELECT table_id, seat_index FROM floor_seat_claims")).rows;
    const has = (i: number) => seats.some((r) => r.table_id === nthSeat(i).table && r.seat_index === nthSeat(i).seat);
    expect(has(1)).toBe(false); // the oldest went
    expect(has(2)).toBe(true);
    expect(has(21)).toBe(true);
    // The release of the oldest and the new claim travel as one mutation.
    const last = (await pg.query<{ mutation_id: string }>("SELECT mutation_id FROM outbox ORDER BY created_at DESC LIMIT 1")).rows[0]?.mutation_id;
    const sameMutation = await pg.query<{ is_deleted: boolean }>("SELECT is_deleted FROM seat_claims_local WHERE mutation_id = $1 ORDER BY is_deleted", [last]);
    expect(sameMutation.rows.map((r) => r.is_deleted)).toEqual([false, true]);
  });

  it("releasing one chair frees room, so the next claim releases nothing", async () => {
    for (let i = 1; i <= 20; i++) await claim(i);
    await pg.exec(`DELETE FROM floor_seat_claims WHERE table_id = '${nthSeat(20).table}' AND seat_index = ${nthSeat(20).seat}`);
    expect(await held()).toBe(19);
    await claim(21);
    expect(await held()).toBe(20);
    const tombstones = await pg.query("SELECT * FROM seat_claims_local WHERE is_deleted");
    expect(tombstones.rows).toHaveLength(1); // only the explicit release
  });

  it("rejects chairs that do not exist, occupied chairs and other people's claims", async () => {
    await expect(pg.exec(`INSERT INTO floor_seat_claims (table_id, seat_index) VALUES ('${T1}', 5)`)).rejects.toThrow(/no existe/);
    await pg.exec(`INSERT INTO seat_claims_synced (table_id, seat_index, room_id, owner_tag, client_name)
      VALUES ('${T1}', 3, 'r', '${OTHER_TAG}', 'TapirMenta')`);
    await expect(pg.exec(`INSERT INTO floor_seat_claims (table_id, seat_index) VALUES ('${T1}', 3)`)).rejects.toThrow(/ocupada/);
    await expect(pg.exec(`DELETE FROM floor_seat_claims WHERE seat_index = 3`)).rejects.toThrow(/propia/);
  });
});

describe("admin guards", () => {
  beforeEach(() => setup(true));

  it("has no chair limit", async () => {
    for (let i = 1; i <= 30; i++) await claim(i);
    expect(await held()).toBe(30);
    expect((await pg.query("SELECT * FROM seat_claims_local WHERE is_deleted")).rows).toHaveLength(0);
  });

  it("can lock, rename, and release someone else's chair", async () => {
    await pg.exec(`UPDATE floor_room SET is_locked = true`);
    await pg.exec(`UPDATE floor_tables SET label = 'VIP' WHERE id = '${T1}'`);
    await pg.exec(`INSERT INTO seat_claims_synced (table_id, seat_index, room_id, owner_tag, client_name)
      VALUES ('${T1}', 3, 'r', '${OTHER_TAG}', 'TapirMenta')`);
    await pg.exec(`DELETE FROM floor_seat_claims WHERE seat_index = 3`);
    expect(await outboxCount()).toBe(3);
  });

  it("cannot remove chairs below the highest claimed seat", async () => {
    await pg.exec(`INSERT INTO seat_claims_synced (table_id, seat_index, room_id, owner_tag, client_name)
      VALUES ('${T1}', 4, 'r', '${OTHER_TAG}', 'TapirMenta')`);
    await expect(pg.exec(`UPDATE floor_tables SET seat_limit = 3 WHERE id = '${T1}'`)).rejects.toThrow(/ocupadas/);
  });
});
