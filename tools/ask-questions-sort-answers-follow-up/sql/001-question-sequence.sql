create table if not exists question_sequence (id text primary key, value jsonb not null, form_id text generated always as (value->>'formId') stored, updated_at timestamptz not null default now())
