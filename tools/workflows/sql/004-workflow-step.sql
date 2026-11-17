create table if not exists workflow_step (id text primary key, recipe text not null, position integer not null, value jsonb not null)
