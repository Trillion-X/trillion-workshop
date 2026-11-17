create table if not exists workspace_record (id text primary key, value jsonb not null, updated_at timestamptz not null default now())
