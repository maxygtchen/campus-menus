-- =====================================================================
-- Ratings database for campus-menus  (paste into Supabase > SQL Editor)
--
-- The idea in plain words:
--   * Every thumbs up/down is one row in the `ratings` table.
--   * Each phone signs in anonymously, so each row belongs to a user.
--   * Row Level Security (RLS) is the lock on the table: a user can only
--     see and change THEIR OWN rows. Nobody can read who voted for what.
--   * The app never reads other people's rows. It calls get_scores(),
--     which only hands back totals (how many ups, how many downs).
--
-- Safe to run more than once.
-- =====================================================================

create table if not exists public.ratings (
  id          bigint generated always as identity primary key,
  user_id     uuid        not null default auth.uid()
                          references auth.users (id) on delete cascade,
  school      text        not null check (char_length(school)   between 1 and 40),
  dish_key    text        not null check (char_length(dish_key) between 1 and 160),
  location    text        not null check (char_length(location) between 1 and 80),
  period      text        not null check (char_length(period)   between 1 and 30),
  served_on   date        not null,
  vote        smallint    not null check (vote in (-1, 1)),   -- 1 = up, -1 = down
  created_at  timestamptz not null default now(),

  -- One vote per person, per dish, per hall, per meal. Voting again
  -- replaces the old vote instead of adding a second one.
  constraint one_vote_per_meal
    unique (user_id, school, dish_key, location, period, served_on)
);

create index if not exists ratings_lookup
  on public.ratings (school, dish_key, served_on);

-- ---------------------------------------------------------------------
-- Row Level Security: who may touch which rows
-- ---------------------------------------------------------------------
alter table public.ratings enable row level security;

drop policy if exists "read own votes"   on public.ratings;
drop policy if exists "add own votes"    on public.ratings;
drop policy if exists "change own votes" on public.ratings;
drop policy if exists "remove own votes" on public.ratings;

create policy "read own votes" on public.ratings
  for select to authenticated
  using (user_id = auth.uid());

-- You can only rate meals served around today (a day of slack covers
-- time zones), so nobody can stuff votes into the past or the future.
create policy "add own votes" on public.ratings
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and served_on between current_date - 1 and current_date + 1
  );

create policy "change own votes" on public.ratings
  for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and served_on between current_date - 1 and current_date + 1
  );

create policy "remove own votes" on public.ratings
  for delete to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- get_scores: totals only, never individual votes
--
-- Returns one row per (dish, hall, meal, is it today?) with counts.
-- "security definer" lets this one function count everyone's rows even
-- though users can't read them directly.
-- ---------------------------------------------------------------------
create or replace function public.get_scores(
  p_school    text,
  p_date      date,
  p_dish_keys text[]
)
returns table (
  dish_key text,
  location text,
  period   text,
  is_today boolean,
  ups      integer,
  downs    integer
)
language sql
stable
security definer
set search_path = public
as $$
  select r.dish_key,
         r.location,
         r.period,
         (r.served_on = p_date)                        as is_today,
         (count(*) filter (where r.vote =  1))::integer as ups,
         (count(*) filter (where r.vote = -1))::integer as downs
  from public.ratings r
  where r.school = p_school
    and r.dish_key = any (p_dish_keys)
    and r.served_on <= p_date
  group by r.dish_key, r.location, r.period, (r.served_on = p_date);
$$;

revoke all on function public.get_scores(text, date, text[]) from public;
grant execute on function public.get_scores(text, date, text[]) to anon, authenticated;

-- Table permissions (RLS above still decides which rows).
grant select, insert, update, delete on public.ratings to authenticated;
