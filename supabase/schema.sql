-- ============================================================
-- Badman schema — v2 (IDEMPOTENT: safe to re-run on existing DBs)
-- Adds: country flags, OS details, ban support, while keeping
-- every existing table/column intact.
-- Apply with: node server/apply_schema.mjs
-- ============================================================
create extension if not exists "pgcrypto";

-- ---------- Agents ----------
create table if not exists public.agents (
  id uuid primary key default gen_random_uuid(),
  agent_token text unique not null,
  hostname text,
  ip_address text,
  os_version text,
  last_seen timestamptz,
  status text default 'offline',
  created_at timestamptz default now()
);

-- v2 columns (no-op if they already exist)
alter table public.agents add column if not exists os_name text;        -- windows | linux | macos | android | unknown
alter table public.agents add column if not exists os_arch text;        -- x86_64, arm64, ...
alter table public.agents add column if not exists platform text;       -- full platform string from agent
alter table public.agents add column if not exists username text;       -- active user on the agent
alter table public.agents add column if not exists country text;        -- country name
alter table public.agents add column if not exists country_code text;   -- ISO 3166-1 alpha-2 ("US") -> flag emoji
alter table public.agents add column if not exists isp text;            -- ISP / org from geo lookup
alter table public.agents add column if not exists banned boolean default false;
alter table public.agents add column if not exists ban_reason text;

create index if not exists agents_status_idx on public.agents (status);
create index if not exists agents_banned_idx on public.agents (banned);

-- ---------- Command logs (now actually used: script runs + results) ----------
create table if not exists public.command_logs (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents(id) on delete cascade,
  command text,
  output text,
  executed_at timestamptz default now(),
  operator_username text
);

create index if not exists command_logs_agent_idx on public.command_logs (agent_id, executed_at desc);

-- ---------- Saved scripts ----------
create table if not exists public.scripts (
  id uuid primary key default gen_random_uuid(),
  name text,
  language text check (language in ('powershell','vbscript')),
  content text,
  created_by text,
  created_at timestamptz default now()
);

-- ---------- Row Level Security (Supabase) ----------
alter table public.agents enable row level security;
alter table public.command_logs enable row level security;
alter table public.scripts enable row level security;

-- Idempotent policies: drop + recreate
drop policy if exists "Service role can manage agents" on public.agents;
create policy "Service role can manage agents"
  on public.agents for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists "Service role can manage command_logs" on public.command_logs;
create policy "Service role can manage command_logs"
  on public.command_logs for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists "Service role can manage scripts" on public.scripts;
create policy "Service role can manage scripts"
  on public.scripts for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
