create table if not exists follow_up_sequence (id text primary key, value jsonb not null, updated_at timestamptz not null default now())
