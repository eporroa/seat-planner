// Milestone 5: admin batch operations and a rejection log for /debug.
export const migration004 = /* sql */ `
-- Align / distribute / tidy move several tables at once. They travel as ONE
-- mutation so the server validates the final layout, not each intermediate step.
CREATE FUNCTION local_move_tables(items jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  m uuid := gen_random_uuid();
  it jsonb;
BEGIN
  IF NOT COALESCE((SELECT p.is_admin FROM profile p LIMIT 1), false) THEN
    RAISE EXCEPTION 'Solo el admin puede acomodar mesas';
  END IF;
  FOR it IN SELECT * FROM jsonb_array_elements(items) LOOP
    INSERT INTO tables_local (id, room_id, label, shape, pos_x, pos_y, seat_limit,
      shape_radius, shape_width, shape_height, mutation_id, is_deleted)
    SELECT t.id, t.room_id, t.label, t.shape, (it->>'pos_x')::integer, (it->>'pos_y')::integer, t.seat_limit,
      t.shape_radius, t.shape_width, t.shape_height, m, false
    FROM floor_tables t WHERE t.id = (it->>'id')::uuid
    ON CONFLICT (id) DO UPDATE SET pos_x = EXCLUDED.pos_x, pos_y = EXCLUDED.pos_y, mutation_id = m;
  END LOOP;
  INSERT INTO outbox (mutation_id, entity, op, payload)
  VALUES (m, 'table', 'batch_update', jsonb_build_object('tables', items));
END $$;

-- Reset has no optimistic state: the server replaces the layout and the echo
-- (rows carrying this mutation id) clears the outbox row.
CREATE FUNCTION local_reset_room() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT COALESCE((SELECT p.is_admin FROM profile p LIMIT 1), false) THEN
    RAISE EXCEPTION 'Solo el admin puede restablecer la demo';
  END IF;
  INSERT INTO outbox (mutation_id, entity, op, payload)
  VALUES (gen_random_uuid(), 'room', 'reset', '{}'::jsonb);
END $$;

CREATE TABLE rejection_log (
  id bigserial PRIMARY KEY,
  mutation_id uuid NOT NULL,
  entity text NOT NULL,
  op text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;
