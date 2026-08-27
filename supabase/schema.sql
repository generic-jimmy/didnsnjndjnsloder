-- Enable UUID generation
create extension if not exists "pgcrypto";

-- Agents table: stores connected endpoints
create table public.agents (
  id uuid primary key default gen_random_uuid(),
  agent_token text unique not null,
  hostname text,
  ip_address text,
  os_version text,
  last_seen timestamptz,
  status text default 'offline',
  created_at timestamptz default now()
);

-- Command logs: stores commands sent to agents and their output
create table public.command_logs (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents(id) on delete cascade,
  command text,
  output text,
  executed_at timestamptz default now(),
  operator_username text  -- username of the operator who issued the command
);

-- Saved scripts: reusable PowerShell/VBScript snippets
create table public.scripts (
  id uuid primary key default gen_random_uuid(),
  name text,
  language text check (language in ('powershell','vbscript')),
  content text,
  created_by text,  -- username of the operator who saved the script
  created_at timestamptz default now()
);

-- Enable Row Level Security on all tables
alter table public.agents enable row level security;
alter table public.command_logs enable row level security;
alter table public.scripts enable row level security;

-- Policies: only the service_role (used by the Node.js server) can access tables
create policy "Service role can manage agents"
  on public.agents for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "Service role can manage command_logs"
  on public.command_logs for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "Service role can manage scripts"
  on public.scripts for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');