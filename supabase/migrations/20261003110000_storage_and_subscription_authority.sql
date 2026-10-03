-- FieldInspect Pro commercial storage + subscription authority
-- Applied to project aynlfxquofvlnthxuqcl after live verification.
-- Keeps evidence private and makes inspection/PDF usage counters server-backed.

insert into storage.buckets (id,name,public,file_size_limit)
values ('fieldinspect-evidence','fieldinspect-evidence',false,12582912)
on conflict (id) do update
set public=false,file_size_limit=12582912;

revoke all on table storage.objects from anon, authenticated;
grant select, insert, update, delete on table storage.objects to authenticated;

drop policy if exists "FieldInspect evidence read" on storage.objects;
drop policy if exists "FieldInspect evidence upload" on storage.objects;
drop policy if exists "FieldInspect evidence update" on storage.objects;
drop policy if exists "FieldInspect evidence delete" on storage.objects;

create policy "FieldInspect evidence read"
on storage.objects for select to authenticated
using (
  bucket_id='fieldinspect-evidence'
  and (storage.foldername(name))[1]=(select auth.uid())::text
);

create policy "FieldInspect evidence upload"
on storage.objects for insert to authenticated
with check (
  bucket_id='fieldinspect-evidence'
  and (storage.foldername(name))[1]=(select auth.uid())::text
);

create policy "FieldInspect evidence update"
on storage.objects for update to authenticated
using (
  bucket_id='fieldinspect-evidence'
  and (storage.foldername(name))[1]=(select auth.uid())::text
)
with check (
  bucket_id='fieldinspect-evidence'
  and (storage.foldername(name))[1]=(select auth.uid())::text
);

create policy "FieldInspect evidence delete"
on storage.objects for delete to authenticated
using (
  bucket_id='fieldinspect-evidence'
  and (storage.foldername(name))[1]=(select auth.uid())::text
);

create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('pdf_export')),
  reference_id text not null,
  created_at timestamptz not null default now(),
  unique(user_id,kind,reference_id)
);

alter table public.usage_events enable row level security;
revoke all on public.usage_events from anon, authenticated;
grant select, insert on public.usage_events to authenticated;

drop policy if exists "Users can read own usage events" on public.usage_events;
create policy "Users can read own usage events" on public.usage_events
for select to authenticated
using ((select auth.uid())=user_id);

drop policy if exists "Users can create own usage events" on public.usage_events;
create policy "Users can create own usage events" on public.usage_events
for insert to authenticated
with check ((select auth.uid())=user_id);

create or replace function public.apply_pdf_usage_event()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare s public.subscriptions;
begin
  select * into s from public.subscriptions where user_id=new.user_id for update;
  if not found then raise exception 'SUBSCRIPTION_NOT_FOUND'; end if;
  if s.status not in ('TRIAL','ACTIVE') then raise exception 'SUBSCRIPTION_INACTIVE'; end if;
  if s.pdf_limit is not null and s.pdf_exports_used>=s.pdf_limit then raise exception 'PDF_LIMIT_REACHED'; end if;
  update public.subscriptions set pdf_exports_used=pdf_exports_used+1 where id=s.id;
  return new;
end;
$$;

revoke execute on function public.apply_pdf_usage_event() from public,anon,authenticated;

drop trigger if exists trg_apply_pdf_usage_event on public.usage_events;
create trigger trg_apply_pdf_usage_event
after insert on public.usage_events
for each row execute function public.apply_pdf_usage_event();

create or replace function public.enforce_inspection_usage()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare s public.subscriptions;
begin
  select * into s from public.subscriptions where user_id=new.user_id for update;
  if not found then raise exception 'SUBSCRIPTION_NOT_FOUND'; end if;
  if s.status not in ('TRIAL','ACTIVE') then raise exception 'SUBSCRIPTION_INACTIVE'; end if;
  if s.inspection_limit is not null and s.inspections_used>=s.inspection_limit then raise exception 'INSPECTION_LIMIT_REACHED'; end if;
  update public.subscriptions set inspections_used=inspections_used+1 where id=s.id;
  return new;
end;
$$;

revoke execute on function public.enforce_inspection_usage() from public,anon,authenticated;

drop trigger if exists trg_enforce_inspection_usage on public.inspections;
create trigger trg_enforce_inspection_usage
after insert on public.inspections
for each row execute function public.enforce_inspection_usage();

-- Keep subscription access read-only to clients; server-side billing functions own writes.
revoke all on public.subscriptions from anon,authenticated;
grant select,insert on public.subscriptions to authenticated;

drop policy if exists "Users can read own subscription" on public.subscriptions;
create policy "Users can read own subscription" on public.subscriptions
for select to authenticated
using ((select auth.uid())=user_id);

drop policy if exists "Users can create own subscription" on public.subscriptions;
create policy "Users can create own subscription" on public.subscriptions
for insert to authenticated
with check ((select auth.uid())=user_id);

-- Trial bootstrap is invoker-secure: the caller can only create/read their own row.
alter function public.ensure_trial_subscription() security invoker;
alter function public.ensure_trial_subscription() set search_path=public;
revoke execute on function public.ensure_trial_subscription() from public,anon;
grant execute on function public.ensure_trial_subscription() to authenticated;

alter function public.touch_billing_updated_at() set search_path=public;

revoke execute on function public.handle_new_user_profile() from public,anon,authenticated;
revoke execute on function public.increment_inspection_usage(uuid) from public,anon,authenticated;
revoke execute on function public.increment_pdf_usage(uuid) from public,anon,authenticated;
revoke execute on function public.rls_auto_enable() from public,anon,authenticated;

-- Reconcile the already-existing inspections with the current subscription counter.
update public.subscriptions s
set inspections_used=x.inspection_count,updated_at=now()
from (
  select user_id,count(*)::int inspection_count
  from public.inspections
  group by user_id
) x
where s.user_id=x.user_id;
