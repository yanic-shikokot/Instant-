-- FieldInspect Pro: keep inspection cloud sync independent of subscription/billing.
-- This migration mirrors the production schema change applied on 2026-10-05.
-- The RPC remains authenticated and SECURITY INVOKER so inspections are protected by RLS.

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
security invoker
set search_path = public
as $function$
declare
  v_user_id uuid := auth.uid();
  v_existing public.inspections;
  v_now timestamptz := now();
begin
  if v_user_id is null then raise exception 'AUTHENTICATION_REQUIRED'; end if;
  if nullif(trim(coalesce(p_local_id, '')), '') is null then raise exception 'LOCAL_ID_REQUIRED'; end if;
  if p_status is null or p_status not in ('draft','in-progress','completed','archived') then
    raise exception 'INVALID_INSPECTION_STATUS';
  end if;

  select * into v_existing
    from public.inspections
   where user_id = v_user_id and local_id = p_local_id
   limit 1 for update;

  if found then
    update public.inspections
       set title = coalesce(p_title, title),
           client_name = coalesce(p_client_name, client_name),
           site_name = coalesce(p_site_name, site_name),
           status = p_status,
           inspection_date = p_inspection_date,
           data = coalesce(p_data, '{}'::jsonb),
           updated_at = greatest(coalesce(p_updated_at, v_now), coalesce(updated_at, '-infinity'::timestamptz))
     where id = v_existing.id
     returning * into v_existing;
    return v_existing;
  end if;

  insert into public.inspections (
    user_id, local_id, title, client_name, site_name, status,
    inspection_date, data, created_at, updated_at
  )
  values (
    v_user_id, p_local_id, p_title, p_client_name, p_site_name, p_status,
    p_inspection_date, coalesce(p_data, '{}'::jsonb),
    coalesce(p_created_at, v_now), coalesce(p_updated_at, v_now)
  )
  returning * into v_existing;

  return v_existing;
end;
$function$;

revoke execute on function public.sync_inspection(text,text,text,text,text,date,jsonb,timestamptz,timestamptz) from public;
revoke execute on function public.sync_inspection(text,text,text,text,text,date,jsonb,timestamptz,timestamptz) from anon;
grant execute on function public.sync_inspection(text,text,text,text,text,date,jsonb,timestamptz,timestamptz) to authenticated;
