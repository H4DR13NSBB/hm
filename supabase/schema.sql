-- =====================================================================
-- Duo: a shared daily board for two people
-- Run this whole file once in Supabase: Dashboard > SQL Editor > New query
-- =====================================================================

-- ---------------------------------------------------------------------
-- Members: the only users allowed to use the app (you add both by hand)
-- ---------------------------------------------------------------------
create table if not exists public.members (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40)
);
alter table public.members enable row level security;

create or replace function public.is_member()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.members where user_id = auth.uid());
$$;

drop policy if exists "members can see members" on public.members;
create policy "members can see members"
  on public.members for select to authenticated
  using (public.is_member());

-- ---------------------------------------------------------------------
-- Settings: one row. The timezone decides when "midnight" is for both of you.
-- Change it in add-members.sql (e.g. 'Europe/Paris', 'America/New_York').
-- ---------------------------------------------------------------------
create table if not exists public.settings (
  id       boolean primary key default true check (id),
  timezone text not null default 'UTC' check (now() at time zone timezone is not null)
);
insert into public.settings default values on conflict do nothing;
alter table public.settings enable row level security;

drop policy if exists "members read settings" on public.settings;
create policy "members read settings"
  on public.settings for select to authenticated
  using (public.is_member());

-- Today's date in the board's timezone. Only today's section is editable.
create or replace function public.board_today()
returns date
language sql stable security definer set search_path = ''
as $$
  select (now() at time zone (select timezone from public.settings limit 1))::date;
$$;

-- ---------------------------------------------------------------------
-- Board items: notes and photos placed freely on a day's section.
-- Coordinates are in "board units": the board is 1000 units wide,
-- so the layout looks the same on every screen size.
-- ---------------------------------------------------------------------
create table if not exists public.items (
  id         bigint generated always as identity primary key,
  day        date not null default public.board_today(),
  author_id  uuid not null default auth.uid() references public.members(user_id) on delete cascade,
  kind       text not null check (kind in ('text', 'photo')),
  x          real not null check (x between 0 and 1000),
  y          real not null check (y between 0 and 100000),
  w          real check (w between 50 and 1000),        -- photo width
  aspect     real check (aspect between 0.1 and 10),    -- photo width / height
  size       real check (size between 10 and 200),      -- text size
  body       text check (char_length(body) <= 2000),
  image_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint item_content check (
    (kind = 'text'  and body is not null and char_length(btrim(body)) > 0)
    or
    (kind = 'photo' and image_path is not null and w is not null and aspect is not null)
  )
);
create index if not exists items_day_idx on public.items (day desc);

alter table public.items enable row level security;

drop policy if exists "members read items" on public.items;
create policy "members read items"
  on public.items for select to authenticated
  using (public.is_member());

drop policy if exists "add to today only" on public.items;
create policy "add to today only"
  on public.items for insert to authenticated
  with check (
    public.is_member()
    and author_id = auth.uid()
    and day = public.board_today()
    and (image_path is null or image_path like auth.uid()::text || '/%')
  );

drop policy if exists "edit own items today only" on public.items;
create policy "edit own items today only"
  on public.items for update to authenticated
  using (author_id = auth.uid() and day = public.board_today())
  with check (
    author_id = auth.uid()
    and day = public.board_today()
    and (image_path is null or image_path like auth.uid()::text || '/%')
  );

drop policy if exists "delete own items today only" on public.items;
create policy "delete own items today only"
  on public.items for delete to authenticated
  using (author_id = auth.uid() and day = public.board_today());

create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists items_touch on public.items;
create trigger items_touch before update on public.items
  for each row execute function public.touch_updated_at();

-- The N most recent days that have something on them, before a given day.
-- Used to load the board page by page as you scroll back in time.
create or replace function public.board_days(before date, n int default 7)
returns table (day date)
language sql stable set search_path = ''
as $$
  select distinct i.day from public.items i
   where i.day < before
   order by i.day desc
   limit least(n, 60);
$$;

-- ---------------------------------------------------------------------
-- Lists: shared checklists (call topics, groceries, ...). Both people can
-- add, tick, edit and delete anything. No day locking here.
-- ---------------------------------------------------------------------
create table if not exists public.lists (
  id         bigint generated always as identity primary key,
  name       text not null check (char_length(btrim(name)) between 1 and 60),
  created_by uuid default auth.uid() references public.members(user_id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.list_items (
  id         bigint generated always as identity primary key,
  list_id    bigint not null references public.lists(id) on delete cascade,
  body       text not null check (char_length(btrim(body)) between 1 and 500),
  done       boolean not null default false,
  done_at    timestamptz,
  added_by   uuid default auth.uid() references public.members(user_id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists list_items_list_idx on public.list_items (list_id);

alter table public.lists enable row level security;
alter table public.list_items enable row level security;

drop policy if exists "members manage lists" on public.lists;
create policy "members manage lists"
  on public.lists for all to authenticated
  using (public.is_member())
  with check (public.is_member());

drop policy if exists "members manage list items" on public.list_items;
create policy "members manage list items"
  on public.list_items for all to authenticated
  using (public.is_member())
  with check (public.is_member());

-- A first list to start with
insert into public.lists (name)
select 'Call topics' where not exists (select 1 from public.lists);

-- ---------------------------------------------------------------------
-- Trips: plan, ideas (entries with no day), map pins, packing list, money.
-- Both people can edit everything.
-- ---------------------------------------------------------------------
create table if not exists public.trips (
  id          bigint generated always as identity primary key,
  name        text not null check (char_length(btrim(name)) between 1 and 80),
  destination text check (char_length(destination) <= 120),
  start_date  date not null,
  end_date    date not null,
  created_by  uuid default auth.uid() references public.members(user_id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint trip_dates check (end_date >= start_date and end_date - start_date <= 90)
);

create table if not exists public.trip_entries (
  id           bigint generated always as identity primary key,
  trip_id      bigint not null references public.trips(id) on delete cascade,
  day          date,                -- null = idea, not scheduled yet
  time         time,
  kind         text not null default 'activity'
               check (kind in ('flight', 'stay', 'activity', 'food', 'transport', 'place', 'other')),
  title        text not null check (char_length(btrim(title)) between 1 and 200),
  place        text check (char_length(place) <= 300),
  url          text check (char_length(url) <= 2000),
  confirmation text check (char_length(confirmation) <= 120),
  notes        text check (char_length(notes) <= 4000),
  lat          double precision check (lat between -90 and 90),
  lng          double precision check (lng between -180 and 180),
  created_by   uuid default auth.uid() references public.members(user_id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists trip_entries_trip_idx on public.trip_entries (trip_id);

create table if not exists public.trip_expenses (
  id           bigint generated always as identity primary key,
  trip_id      bigint not null references public.trips(id) on delete cascade,
  kind         text not null default 'expense' check (kind in ('expense', 'settlement')),
  paid_by      uuid not null references public.members(user_id) on delete cascade,
  amount_cents integer not null check (amount_cents > 0 and amount_cents < 100000000),
  currency     text not null check (currency in ('USD', 'CHF')),
  note         text check (char_length(note) <= 200),
  spent_on     date not null default current_date,
  created_by   uuid default auth.uid() references public.members(user_id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists trip_expenses_trip_idx on public.trip_expenses (trip_id);

-- A trip's packing list is a normal list tied to the trip (hidden from the Lists tab)
alter table public.lists add column if not exists trip_id bigint references public.trips(id) on delete cascade;

alter table public.trips enable row level security;
alter table public.trip_entries enable row level security;
alter table public.trip_expenses enable row level security;

drop policy if exists "members manage trips" on public.trips;
create policy "members manage trips" on public.trips for all to authenticated
  using (public.is_member()) with check (public.is_member());

drop policy if exists "members manage trip entries" on public.trip_entries;
create policy "members manage trip entries" on public.trip_entries for all to authenticated
  using (public.is_member()) with check (public.is_member());

drop policy if exists "members manage trip expenses" on public.trip_expenses;
create policy "members manage trip expenses" on public.trip_expenses for all to authenticated
  using (public.is_member()) with check (public.is_member());

-- ---------------------------------------------------------------------
-- Mail: postcards. Front and back each have an optional photo and text.
-- The database picks when a card arrives (2-15 days, see below), and the
-- recipient can't read it before then. Once posted it can't be changed.
-- ---------------------------------------------------------------------
create table if not exists public.postcards (
  id          bigint generated always as identity primary key,
  from_id     uuid not null default auth.uid() references public.members(user_id) on delete cascade,
  to_id       uuid not null references public.members(user_id) on delete cascade,
  stamp       text not null check (char_length(stamp) between 1 and 30),
  front_image text,
  front_text  text check (char_length(front_text) <= 200),
  front_bg    text check (front_bg ~ '^#[0-9a-fA-F]{6}$'),
  back_image  text,
  back_text   text check (char_length(back_text) <= 500),
  back_bg     text check (back_bg ~ '^#[0-9a-fA-F]{6}$'),
  sent_at     timestamptz not null default now(),
  delivers_at timestamptz not null default now(),
  read_at     timestamptz,
  constraint postcard_to_someone_else check (to_id <> from_id),
  constraint postcard_has_front check (front_image is not null or char_length(btrim(coalesce(front_text, ''))) > 0)
);
create index if not exists postcards_to_idx on public.postcards (to_id, delivers_at);
create index if not exists postcards_from_idx on public.postcards (from_id);

-- Posting: the server stamps it and decides the delivery date.
-- Days in the post follow a normal distribution (mean 8.5, sd 2.2, Box-Muller),
-- redrawn until it lands in 2..15, so most cards take about a week.
create or replace function public.postcard_post()
returns trigger language plpgsql set search_path = '' as $$
declare d int;
begin
  new.from_id := auth.uid();
  new.sent_at := now();
  new.read_at := null;
  loop
    d := round(8.5 + 2.2 * sqrt(-2 * ln(1 - random())) * cos(2 * pi() * random()));
    exit when d between 2 and 15;
  end loop;
  new.delivers_at := now() + make_interval(days => d);
  return new;
end $$;

drop trigger if exists postcards_post on public.postcards;
create trigger postcards_post before insert on public.postcards
  for each row execute function public.postcard_post();

alter table public.postcards enable row level security;

drop policy if exists "read sent and arrived postcards" on public.postcards;
create policy "read sent and arrived postcards"
  on public.postcards for select to authenticated
  using (from_id = auth.uid() or (to_id = auth.uid() and delivers_at <= now()));

drop policy if exists "post postcards" on public.postcards;
create policy "post postcards"
  on public.postcards for insert to authenticated
  with check (
    public.is_member()
    and from_id = auth.uid()
    and exists (select 1 from public.members m where m.user_id = to_id)
    and (front_image is null or front_image like auth.uid()::text || '/%')
    and (back_image is null or back_image like auth.uid()::text || '/%')
  );
-- no update/delete policies: once it's in the post, it's in the post

-- How many cards are on their way to me (just the number, not the cards)
create or replace function public.mail_in_transit()
returns int
language sql stable security definer set search_path = ''
as $$
  select count(*)::int from public.postcards where to_id = auth.uid() and delivers_at > now();
$$;

-- The recipient opened an arrived card
create or replace function public.mark_postcard_read(card_id bigint)
returns void
language sql security definer set search_path = ''
as $$
  update public.postcards set read_at = now()
   where id = card_id and to_id = auth.uid() and delivers_at <= now() and read_at is null;
$$;

-- Live updates
do $$
begin
  alter publication supabase_realtime add table public.postcards;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.items;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.lists;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.list_items;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.trips;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.trip_entries;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.trip_expenses;
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------
-- Storage: private bucket for photos, files stored as <user_id>/<id>.jpg
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "members view photos" on storage.objects;
create policy "members view photos"
  on storage.objects for select to authenticated
  using (bucket_id = 'photos' and public.is_member());

drop policy if exists "members upload to own folder" on storage.objects;
create policy "members upload to own folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'photos'
    and public.is_member()
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "members delete own photos" on storage.objects;
create policy "members delete own photos"
  on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
