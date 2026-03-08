-- ============================================================
-- CLARITY SOBRIETY APP — SUPABASE DATABASE SCHEMA
-- Run this in your Supabase SQL Editor (supabase.com → SQL Editor)
-- ============================================================

-- Enable UUID generation
create extension if not exists "uuid-ossp";

-- ============================================================
-- 1. USERS (extends Supabase auth.users)
-- ============================================================
create table public.profiles (
  id              uuid references auth.users(id) on delete cascade primary key,
  display_name    text,
  avatar_emoji    text default '🌙',
  sobriety_start  date not null default current_date,
  substance       text default 'alcohol',        -- alcohol, substances, both, other
  daily_cost      numeric(8,2) default 20.00,    -- estimated daily cost saved
  timezone        text default 'America/Vancouver',
  subscription    text default 'free'            -- free, basic, pro, team
    check (subscription in ('free','basic','pro','team')),
  stripe_customer_id text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- Trigger: keep updated_at fresh
create or replace function handle_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger profiles_updated_at
  before update on public.profiles
  for each row execute function handle_updated_at();

-- Auto-create profile when user signs up
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email,'@',1)));
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ============================================================
-- 2. DAILY CHECK-INS
-- ============================================================
create table public.checkins (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid references public.profiles(id) on delete cascade not null,
  checked_in_at date not null default current_date,
  mood        text check (mood in ('rough','meh','okay','good','great')),
  note        text,
  created_at  timestamptz default now(),
  unique(user_id, checked_in_at)
);

-- ============================================================
-- 3. WINS / ACHIEVEMENTS
-- ============================================================
create table public.wins (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid references public.profiles(id) on delete cascade not null,
  title       text not null,
  category    text not null
    check (category in ('health','relationship','personal','work','milestone')),
  shared      boolean default false,   -- visible to village
  like_count  int default 0,
  created_at  timestamptz default now()
);

-- ============================================================
-- 4. JOURNAL ENTRIES
-- ============================================================
create table public.journal_entries (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid references public.profiles(id) on delete cascade not null,
  content     text not null,
  mood        text,
  created_at  timestamptz default now()
);

-- ============================================================
-- 5. VILLAGE — SUPPORT CIRCLE
-- ============================================================
create table public.village_members (
  id              uuid primary key default uuid_generate_v4(),
  owner_id        uuid references public.profiles(id) on delete cascade not null,
  member_id       uuid references public.profiles(id) on delete set null,
  invite_email    text,
  invite_phone    text,
  display_name    text not null,
  role            text not null
    check (role in ('family','friend','sponsor','counsellor','other')),
  avatar_emoji    text default '👤',
  status          text default 'pending'
    check (status in ('pending','active','removed')),
  -- Granular permissions (what this member can see/do)
  can_see_milestones   boolean default true,
  can_see_mood         boolean default false,
  can_see_wins         boolean default false,
  can_message          boolean default true,
  can_see_journal      boolean default false,
  can_connect_team     boolean default false,
  -- Alert settings
  alert_missed_checkin boolean default false,
  alert_milestone      boolean default true,
  alert_rough_mood     boolean default false,
  alert_new_win        boolean default false,
  alert_meeting_attend boolean default false,
  invite_token         text unique default encode(gen_random_bytes(16), 'hex'),
  created_at           timestamptz default now(),
  updated_at           timestamptz default now()
);

create trigger village_members_updated_at
  before update on public.village_members
  for each row execute function handle_updated_at();

-- ============================================================
-- 6. MESSAGES (from village to user, or user to village)
-- ============================================================
create table public.messages (
  id              uuid primary key default uuid_generate_v4(),
  from_user_id    uuid references public.profiles(id) on delete set null,
  to_user_id      uuid references public.profiles(id) on delete cascade not null,
  sender_name     text,               -- for non-app senders (SMS/email replies)
  body            text not null,
  is_comfort_note boolean default false,
  read_at         timestamptz,
  reaction        text,               -- emoji reaction
  created_at      timestamptz default now()
);

-- ============================================================
-- 7. COMFORT NOTES (saved messages)
-- ============================================================
create table public.comfort_notes (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid references public.profiles(id) on delete cascade not null,
  message_id  uuid references public.messages(id) on delete set null,
  text        text not null,
  author_name text,
  created_at  timestamptz default now()
);

-- ============================================================
-- 8. SUBSCRIPTIONS (Stripe webhook data)
-- ============================================================
create table public.subscriptions (
  id                   uuid primary key default uuid_generate_v4(),
  user_id              uuid references public.profiles(id) on delete cascade not null unique,
  stripe_subscription_id text unique,
  stripe_customer_id   text,
  plan                 text not null check (plan in ('basic','pro','team')),
  status               text not null,   -- active, canceled, past_due, trialing
  current_period_start timestamptz,
  current_period_end   timestamptz,
  cancel_at            timestamptz,
  created_at           timestamptz default now(),
  updated_at           timestamptz default now()
);

create trigger subscriptions_updated_at
  before update on public.subscriptions
  for each row execute function handle_updated_at();

-- ============================================================
-- 9. PUSH NOTIFICATION TOKENS (for mobile)
-- ============================================================
create table public.push_tokens (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid references public.profiles(id) on delete cascade not null,
  token       text not null unique,
  platform    text check (platform in ('ios','android','web')),
  created_at  timestamptz default now()
);

-- ============================================================
-- ROW LEVEL SECURITY (RLS) — CRITICAL for privacy
-- ============================================================

-- profiles: users can only read/update their own
alter table public.profiles enable row level security;
create policy "Own profile only" on public.profiles
  for all using (auth.uid() = id);

-- checkins: own only
alter table public.checkins enable row level security;
create policy "Own checkins" on public.checkins
  for all using (auth.uid() = user_id);

-- wins: own, plus village members with permission
alter table public.wins enable row level security;
create policy "Own wins" on public.wins
  for all using (auth.uid() = user_id);
create policy "Village can see shared wins" on public.wins
  for select using (
    shared = true and exists (
      select 1 from public.village_members vm
      where vm.owner_id = wins.user_id
        and vm.member_id = auth.uid()
        and vm.status = 'active'
        and vm.can_see_wins = true
    )
  );

-- journal: own only (completely private)
alter table public.journal_entries enable row level security;
create policy "Own journal" on public.journal_entries
  for all using (auth.uid() = user_id);

-- village_members: owner sees all their members; members see their own record
alter table public.village_members enable row level security;
create policy "Owner sees their village" on public.village_members
  for all using (auth.uid() = owner_id);
create policy "Member sees their own record" on public.village_members
  for select using (auth.uid() = member_id);

-- messages: sender or recipient
alter table public.messages enable row level security;
create policy "Own messages" on public.messages
  for all using (auth.uid() = to_user_id or auth.uid() = from_user_id);

-- comfort_notes: own only
alter table public.comfort_notes enable row level security;
create policy "Own comfort notes" on public.comfort_notes
  for all using (auth.uid() = user_id);

-- subscriptions: own only
alter table public.subscriptions enable row level security;
create policy "Own subscription" on public.subscriptions
  for all using (auth.uid() = user_id);

-- ============================================================
-- USEFUL VIEWS
-- ============================================================

-- Current streak calculation
create or replace view public.user_stats as
select
  p.id,
  p.display_name,
  p.sobriety_start,
  current_date - p.sobriety_start as total_days,
  round((current_date - p.sobriety_start) * p.daily_cost, 2) as money_saved,
  (current_date - p.sobriety_start) * 24 as hours_sober,
  count(c.id) filter (where c.checked_in_at >= current_date - 30) as checkins_this_month,
  (select count(*) from public.wins w where w.user_id = p.id) as total_wins
from public.profiles p
left join public.checkins c on c.user_id = p.id
group by p.id;

-- Unread message count
create or replace view public.unread_counts as
select
  to_user_id as user_id,
  count(*) as unread_messages
from public.messages
where read_at is null
group by to_user_id;
