-- 0004: only memory-api's role may call the core memory functions.
--
-- 0001 grants EXECUTE on these three to service_role but never revokes it from anyone else.
-- Postgres grants EXECUTE on new functions to PUBLIC, and Supabase's default privileges also
-- grant it to anon and authenticated, so both roles could call them. They are SECURITY INVOKER
-- and row level security limits the memory tables to service_role, so no rows were exposed;
-- this closes the grant itself so a later change cannot turn it into a leak.
--
-- Signatures match 0001's own grant lines. 0001 is not edited.

revoke all on function public.archive_memory(uuid, text, text) from public, anon, authenticated;
revoke all on function public.restore_memory(uuid) from public, anon, authenticated;
revoke all on function public.match_memories_basic(vector, int, text) from public, anon, authenticated;

grant execute on function public.archive_memory(uuid, text, text) to service_role;
grant execute on function public.restore_memory(uuid) to service_role;
grant execute on function public.match_memories_basic(vector, int, text) to service_role;
