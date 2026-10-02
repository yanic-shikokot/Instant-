-- FieldInspect Pro Phase 3
-- Cloud inspection storage + multi-device synchronization foundation.

create table if not exists public.inspections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  client_name text,
  site_name text,
  status text not null default 'draft' check (status in ('draft','completed','archived')),
  inspection_date date,
  data jsonb not null default '{}'::jsonb,
  local_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, local_id)
);

create index if not exists inspections_user_updated_idx
on public.inspections(user_id, updated_at desc);

alter table public.inspections enable row level security;

drop policy if exists "Users can read own inspections" on public.inspections;
create policy "Users can read own inspections"
on public.inspections for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Users can create own inspections" on public.inspections;
create policy "Users can create own inspections"
on public.inspections for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "Users can update own inspections" on public.inspections;
create policy "Users can update own inspections"
on public.inspections for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Users can delete own inspections" on public.inspections;
create policy "Users can delete own inspections"
on public.inspections for delete
to authenticated
using (auth.uid() = user_id);

drop trigger if exists inspections_updated_at on public.inspections;
create trigger inspections_updated_at
before update on public.inspections
for each row execute function public.touch_billing_updated_at();

-- Profiles are intentionally minimal; authentication remains owned by Supabase Auth.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  company_name text,
  phone text,
  avatar_url text,
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "Users can read own profile" on public.profiles;
create policy "Users can read own profile"
on public.profiles for select
to authenticated
using (auth.uid() = id);

drop policy if exists "Users can create own profile" on public.profiles;
create policy "Users can create own profile"
on public.profiles for insert
to authenticated
with check (auth.uid() = id);

drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile"
on public.profiles for update
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

create or replace function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data->>'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
after insert on auth.users
for each row execute function public.handle_new_user_profile();
