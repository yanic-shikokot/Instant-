-- FieldInspect Pro billing schema
-- Phase 2B: cloud subscriptions + M-Pesa payment records

create extension if not exists pgcrypto;

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan text not null default 'trial' check (plan in ('trial','professional','business','enterprise')),
  status text not null default 'TRIAL' check (status in ('TRIAL','ACTIVE','PAST_DUE','CANCELLED','EXPIRED')),
  inspection_limit integer,
  pdf_limit integer,
  seat_limit integer,
  inspections_used integer not null default 0 check (inspections_used >= 0),
  pdf_exports_used integer not null default 0 check (pdf_exports_used >= 0),
  started_at timestamptz not null default now(),
  current_period_end timestamptz,
  payment_method text,
  last_payment_id uuid,
  next_billing_date timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  plan text not null check (plan in ('professional','business','enterprise')),
  amount numeric(12,2) not null check (amount > 0),
  currency text not null default 'KES',
  provider text not null default 'mpesa',
  status text not null default 'PENDING' check (status in ('PENDING','SUCCESS','FAILED')),
  phone_number text,
  merchant_request_id text,
  checkout_request_id text,
  mpesa_receipt_number text,
  result_code integer,
  result_description text,
  transaction_id text,
  raw_callback jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists subscriptions_user_id_idx on public.subscriptions(user_id);
create index if not exists payments_user_id_idx on public.payments(user_id);
create index if not exists payments_checkout_request_id_idx on public.payments(checkout_request_id);

alter table public.subscriptions enable row level security;
alter table public.payments enable row level security;

drop policy if exists "Users can read own subscription" on public.subscriptions;
create policy "Users can read own subscription"
on public.subscriptions for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Users can read own payments" on public.payments;
create policy "Users can read own payments"
on public.payments for select
to authenticated
using (auth.uid() = user_id);

create or replace function public.touch_billing_updated_at()
returns trigger
language plpgsql
security invoker
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists subscriptions_updated_at on public.subscriptions;
create trigger subscriptions_updated_at
before update on public.subscriptions
for each row execute function public.touch_billing_updated_at();

-- Atomic server-authorized usage helpers.
-- These are intentionally not granted to anonymous users.
create or replace function public.increment_inspection_usage(p_user_id uuid)
returns public.subscriptions
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.subscriptions;
begin
  update public.subscriptions
  set inspections_used = inspections_used + 1
  where user_id = p_user_id
    and (
      inspection_limit is null
      or inspections_used < inspection_limit
    )
    and status in ('TRIAL','ACTIVE')
  returning * into result;

  if result.id is null then
    raise exception 'INSPECTION_LIMIT_REACHED';
  end if;

  return result;
end;
$$;

create or replace function public.increment_pdf_usage(p_user_id uuid)
returns public.subscriptions
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.subscriptions;
begin
  update public.subscriptions
  set pdf_exports_used = pdf_exports_used + 1
  where user_id = p_user_id
    and (
      pdf_limit is null
      or pdf_exports_used < pdf_limit
    )
    and status in ('TRIAL','ACTIVE')
  returning * into result;

  if result.id is null then
    raise exception 'PDF_LIMIT_REACHED';
  end if;

  return result;
end;
$$;

revoke all on function public.increment_inspection_usage(uuid) from public;
revoke all on function public.increment_pdf_usage(uuid) from public;
grant execute on function public.increment_inspection_usage(uuid) to authenticated;
grant execute on function public.increment_pdf_usage(uuid) to authenticated;

-- New accounts start on the Free Trial.
create or replace function public.ensure_trial_subscription()
returns public.subscriptions
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.subscriptions;
begin
  insert into public.subscriptions (
    user_id, plan, status, inspection_limit, pdf_limit, seat_limit
  )
  values (
    auth.uid(), 'trial', 'TRIAL', 10, 2, 1
  )
  on conflict (user_id) do nothing;

  select * into result
  from public.subscriptions
  where user_id = auth.uid();

  return result;
end;
$$;

revoke all on function public.ensure_trial_subscription() from public;
grant execute on function public.ensure_trial_subscription() to authenticated;
