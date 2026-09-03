-- Run this in Supabase: SQL Editor → New query → Run

create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  device_id text unique not null,
  name text,
  email text,
  phone text,
  usage_reason text,
  age_range text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id) on delete set null,
  device_id text unique not null,
  status text not null default 'none',
  plan_code text,
  amount_paid integer,
  starts_at timestamptz,
  ends_at timestamptz,
  pending_payment_id text,
  last_payment_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id) on delete set null,
  device_id text not null,
  sunrise_payment_id text unique not null,
  amount integer not null,
  status text not null default 'pending',
  payment_url text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_clients_device_id on clients(device_id);
create index if not exists idx_subscriptions_device_id on subscriptions(device_id);
create index if not exists idx_payments_device_id on payments(device_id);
create index if not exists idx_payments_status on payments(status);
