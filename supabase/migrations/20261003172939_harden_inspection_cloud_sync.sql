-- Harden FieldInspect Pro inspection cloud synchronization.
--
-- The client previously relied on a table trigger to enforce subscription usage
-- during an upsert. This made synchronization depend on INSERT trigger behavior
-- and made recovery of local data difficult to reason about. This migration
-- moves the atomic "update existing / create new + consume quota" operation into
-- one authenticated database function.
--
-- Existing rows are never charged again. Only a genuinely new local_id consumes
-- one inspection allowance.

drop trigger if exists trg_enforce_inspection_usage on public.inspections;
drop function if exists public.enforce_inspection_usage();

create or replace function public.sync_inspection(
  p_local_id text,
  p_title text default null,
  p_client_name text default null,
  p_site_name text default null,
  p_status text default 'draft',
  p_inspection_date date default null,
  p_data jsonb default '{}'::jsonb,
  p_created_at timestamptz default null,
  p_updated_at timestamptz default null
)
returns public.inspections
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_existing public.inspections;
  v_subscription public.subscriptions;
  v_now timestamptz := now();
begin
  if v_user_id is null then
    raise exception 'AUTHENTICATION_REQUIRED';
  end if;

  if nullif(trim(coalesce(p_local_id, '')), '') is null then
    raise exception 'LOCAL_ID_REQUIRED';
  end if;

  if p_status is null or p_status not in ('draft','in-progress','completed','archived') then
    raise exception 'INVALID_INSPECTION_STATUS';
  end if;

  select *
    into v_existing
    from public.inspections
   where user_id = v_user_id
     and local_id = p_local_id
   limit 1
   for update;

  if found then
    update public.inspections
       set title = coalesce(p_title, title),
           client_name = coalesce(p_client_name, client_name),
           site_name = coalesce(p_site_name, site_name),
           status = p_status,
           inspection_date = p_inspection_date,
           data = coalesce(p_data, '{}'::jsonb),
           updated_at = greatest(
             coalesce(p_updated_at, v_now),
             coalesce(updated_at, '-infinity'::timestamptz)
           )
     where id = v_existing.id
     returning * into v_existing;

    return v_existing;
  end if;

  select *
    into v_subscription
    from public.subscriptions
   where user_id = v_user_id
   for update;

  if not found then
    raise exception 'SUBSCRIPTION_NOT_FOUND';
  end if;

  if v_subscription.status not in ('TRIAL','ACTIVE') then
    raise exception 'SUBSCRIPTION_INACTIVE';
  end if;

  if v_subscription.inspection_limit is not null
     and v_subscription.inspections_used >= v_subscription.inspection_limit then
    raise exception 'INSPECTION_LIMIT_REACHED';
  end if;

  update public.subscriptions
     set inspections_used = inspections_used + 1
   where id = v_subscription.id;

  insert into public.inspections (
    user_id,
    local_id,
    title,
    client_name,
    site_name,
    status,
    inspection_date,
    data,
    created_at,
    updated_at
  )
  values (
    v_user_id,
    p_local_id,
    p_title,
    p_client_name,
    p_site_name,
    p_status,
    p_inspection_date,
    coalesce(p_data, '{}'::jsonb),
    coalesce(p_created_at, v_now),
    coalesce(p_updated_at, v_now)
  )
  returning * into v_existing;

  return v_existing;
end;
$function$;

revoke execute on function public.sync_inspection(text,text,text,text,text,date,jsonb,timestamptz,timestamptz) from public;
revoke execute on function public.sync_inspection(text,text,text,text,text,date,jsonb,timestamptz,timestamptz) from anon;
grant execute on function public.sync_inspection(text,text,text,text,text,date,jsonb,timestamptz,timestamptz) to authenticated;
