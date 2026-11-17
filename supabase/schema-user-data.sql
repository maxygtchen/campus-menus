-- =====================================================================
-- Per-user private data (profile, taste model votes, plates, prefs)
-- Paste into Supabase > SQL Editor after schema.sql. Safe to re-run.
-- =====================================================================

create table if not exists public.user_data (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  school     text not null check (char_length(school) between 1 and 40),
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists user_data_school on public.user_data (school);

alter table public.user_data enable row level security;

drop policy if exists "read own user_data" on public.user_data;
drop policy if exists "insert own user_data" on public.user_data;
drop policy if exists "update own user_data" on public.user_data;

create policy "read own user_data" on public.user_data
  for select to authenticated
  using (user_id = auth.uid());

create policy "insert own user_data" on public.user_data
  for insert to authenticated
  with check (user_id = auth.uid());

create policy "update own user_data" on public.user_data
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update on public.user_data to authenticated;