-- Sign-up is open, but only to addresses on the allowlist.
--
-- Enforced as a before-user-created auth hook rather than in the sign-up form, because
-- a form check stops a browser and nothing else: the auth endpoint is public and takes
-- a POST from anywhere. Rejecting here means there is one gate and it is the real one.
--
-- The hook must also be switched on in the project's Auth settings, under Hooks →
-- Before User Created, pointing at public.gate_signup_by_domain. Creating the function
-- alone does not arm it.

create or replace function public.gate_signup_by_domain(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate_email text := lower(event -> 'claims' ->> 'email');
  candidate_domain text;
begin
  if candidate_email is null then
    candidate_email := lower(event -> 'user_metadata' ->> 'email');
  end if;
  if candidate_email is null then
    candidate_email := lower(event ->> 'email');
  end if;

  -- An empty allowlist would otherwise lock the owner out of their own project before
  -- the first domain is added, so it means "not configured yet", not "refuse everyone".
  if not exists (select 1 from public.allowed_domains) then
    return event;
  end if;

  candidate_domain := split_part(candidate_email, '@', 2);

  if candidate_domain is null or candidate_domain = '' then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 400,
        'message', 'A sign-up needs an email address.'
      )
    );
  end if;

  if not exists (
    select 1 from public.allowed_domains where domain = candidate_domain
  ) then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', format(
          'This dashboard is not open to %s addresses. Ask the owner for access.',
          candidate_domain
        )
      )
    );
  end if;

  return event;
end;
$$;

grant execute on function public.gate_signup_by_domain(jsonb) to supabase_auth_admin;
revoke execute on function public.gate_signup_by_domain(jsonb) from authenticated, anon, public;
grant usage on schema public to supabase_auth_admin;
grant select on public.allowed_domains to supabase_auth_admin;

-- Every account gets a profile the moment it exists, so there is no window where a
-- signed-in user has no row to hang a role or a grant off.
create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    nullif(new.raw_user_meta_data ->> 'full_name', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.create_profile_for_new_user();
