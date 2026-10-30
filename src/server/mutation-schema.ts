import { z } from "zod";
import {
  RADIUS_MAX, RADIUS_MIN, RECT_SIZE_MAX, RECT_SIZE_MIN, ROOM_HEIGHT, ROOM_WIDTH,
  LABEL_MAX, SEAT_LIMIT_MAX, SEAT_LIMIT_MIN, MAX_TABLES,
} from "@/shared/room";

// Structure and numeric ranges only. Business rules (grid multiples, bounds,
// overlap, permissions) are decided by apply_mutation so every rejection has
// the same, specific reason no matter who calls it.
const uuid = z.uuid();
const int = z.number().int();

const tableFields = {
  id: uuid,
  room_id: z.string().max(64), // sent by the local views; the server ignores it
  label: z.string().max(LABEL_MAX),
  shape: z.enum(["circular", "rectangular"]),
  pos_x: int.min(0).max(ROOM_WIDTH),
  pos_y: int.min(0).max(ROOM_HEIGHT),
  seat_limit: int.min(SEAT_LIMIT_MIN).max(SEAT_LIMIT_MAX),
  shape_radius: int.min(RADIUS_MIN).max(RADIUS_MAX).nullable(),
  shape_width: int.min(RECT_SIZE_MIN).max(RECT_SIZE_MAX).nullable(),
  shape_height: int.min(RECT_SIZE_MIN).max(RECT_SIZE_MAX).nullable(),
};

const tableInsert = z.strictObject({ ...tableFields, room_id: tableFields.room_id.optional() });
const tableUpdate = z.strictObject({
  id: tableFields.id,
  room_id: tableFields.room_id.optional(),
  label: tableFields.label.optional(),
  shape: tableFields.shape.optional(),
  pos_x: tableFields.pos_x.optional(),
  pos_y: tableFields.pos_y.optional(),
  seat_limit: tableFields.seat_limit.optional(),
  shape_radius: tableFields.shape_radius.optional(),
  shape_width: tableFields.shape_width.optional(),
  shape_height: tableFields.shape_height.optional(),
});
const seatRef = z.strictObject({ table_id: uuid, seat_index: int.min(1).max(SEAT_LIMIT_MAX) });

const envelope = <E extends string, O extends string, P extends z.ZodType>(entity: E, op: O, payload: P) =>
  z.strictObject({ mutation_id: uuid, entity: z.literal(entity), op: z.literal(op), payload });

export const mutationSchema = z.union([
  envelope("seat_claim", "insert", seatRef),
  envelope("seat_claim", "delete", seatRef),
  envelope("table", "insert", tableInsert),
  envelope("table", "update", tableUpdate),
  envelope("table", "batch_update", z.strictObject({ tables: z.array(tableUpdate).min(1).max(MAX_TABLES) })),
  envelope("table", "delete", z.strictObject({ id: uuid })),
  envelope("room", "update", z.strictObject({ id: z.string().max(64).optional(), is_locked: z.boolean() })),
  envelope("room", "reset", z.strictObject({})),
]);

export type Mutation = z.infer<typeof mutationSchema>;

export const requestSchema = z.strictObject({
  mutations: z.array(z.unknown()).min(1).max(20),
});

export const mutationIdSchema = z.object({ mutation_id: uuid });

export const mutationResultSchema = z.object({
  mutationId: uuid,
  status: z.enum(["applied", "rejected"]),
  reason: z.string().nullish(),
  retryable: z.boolean().optional(),
});

export type MutationResult = z.infer<typeof mutationResultSchema>;
