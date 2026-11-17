create table if not exists sender_pairing (id text primary key, value jsonb not null, source_id text generated always as (value ->> 'source_id') stored, updated_at timestamptz not null default now())
