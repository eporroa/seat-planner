-- Identifies the database cluster. If it is recreated or restored, WAL
-- positions restart and clients holding resume state must refetch from scratch.
create function demo_epoch() returns text
language sql stable security definer set search_path = public
as $$ select system_identifier::text from pg_control_system() $$;

revoke all on function demo_epoch() from public, anon, authenticated;
grant execute on function demo_epoch() to service_role;
