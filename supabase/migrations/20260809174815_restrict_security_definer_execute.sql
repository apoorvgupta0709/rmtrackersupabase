-- A SECURITY DEFINER function in the `public` schema is reachable at /rest/v1/rpc/<name>
-- by anyone the EXECUTE grant lets in, which by default is everyone. Two of these had no
-- business being callable at all.

-- supersede_slot rewrites which upload the pipeline will read. Called from the ingest
-- route with the service role; exposed to a signed-in browser it would let any viewer
-- retire the current sales dump, or promote a superseded one back over it.
revoke execute on function public.supersede_slot(text, text, uuid) from public, anon, authenticated;
grant  execute on function public.supersede_slot(text, text, uuid) to service_role;

-- A trigger function on auth.users. Only the auth admin ever fires it.
revoke execute on function public.create_profile_for_new_user() from public, anon, authenticated;
grant  execute on function public.create_profile_for_new_user() to supabase_auth_admin;

-- These three are different: they are called inside RLS policy expressions, which
-- Postgres evaluates as the querying role rather than as the policy owner. Revoking
-- EXECUTE from `authenticated` would not harden them, it would make every protected
-- table raise "permission denied for function" on read. They stay callable by signed-in
-- users, which is safe because each reports only on the caller's own grants — is_admin()
-- asks whether *you* are an admin, and answers for nobody else.
--
-- `anon` has no policy that uses them, so it loses them.
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.can_read_view(text) from public, anon;
revoke execute on function public.can_read_any_view(text[]) from public, anon;

grant execute on function public.is_admin() to authenticated;
grant execute on function public.can_read_view(text) to authenticated;
grant execute on function public.can_read_any_view(text[]) to authenticated;
