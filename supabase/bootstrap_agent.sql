-- Bootstrap the first agent row so the remote agent can authenticate.
-- Run once in the Supabase SQL Editor (or apply via the CLI).
-- The agent_token must match AGENT_TOKEN in agent/agent.py.
insert into public.agents (agent_token, hostname, status)
values ('SWB37-BW34T-4UV3D-3339J', 'DESKTOP-AGENT', 'offline')
on conflict (agent_token) do nothing;
