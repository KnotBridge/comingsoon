-- ============================================================================
-- RNQ Agency — Outreach email system, full database schema (single-file setup)
-- Ported from the Renov outreach module, re-fielded for a general-business
-- (Google Maps scraped) contact profile. Real-estate dynamic pages, magic
-- login tokens and property/influencer fields have been removed.
--
-- HOW TO USE: paste the whole file into the Supabase SQL editor and run once
-- on a fresh project. Then set the two placeholders in the pg_cron section
-- (PROJECT_REF and ANON_KEY) — see the marked block at the bottom.
-- ============================================================================

-- ── Extensions ──────────────────────────────────────────────────────────────
create extension if not exists pgcrypto;      -- gen_random_uuid()
-- NOTE: scheduling (send queue, flow tick, IMAP sync) runs on Netlify Scheduled
-- Functions in this build, so pg_cron / pg_net are not used.

-- ── Roles / auth helpers ────────────────────────────────────────────────────
-- Admin-gated app: every table below is manageable only by an 'admin' user.
-- Edge functions use the service_role key and bypass RLS entirely.
do $$ begin
  create type public.app_role as enum ('admin', 'user');
exception when duplicate_object then null; end $$;

create table if not exists public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null default 'user',
  created_at timestamptz not null default now(),
  unique (user_id, role)
);
alter table public.user_roles enable row level security;

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_roles
    where user_id = _user_id and role = _role
  );
$$;

-- Users can read their own roles; admins can read all.
create policy "read own roles" on public.user_roles for select
  using (auth.uid() = user_id or public.has_role(auth.uid(), 'admin'));
create policy "admins manage roles" on public.user_roles for all
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

create or replace function public.update_updated_at_column()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

-- ── Sender groups + accounts ────────────────────────────────────────────────
create table if not exists public.sender_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color text not null default '#BA7517',
  is_default boolean not null default false,
  rotation_cursor integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.email_sender_accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  from_email text not null,
  from_name text not null,
  -- SMTP (outbound)
  smtp_host text not null,
  smtp_user text not null,
  smtp_password text not null,
  smtp_port integer not null default 587,
  -- IMAP (inbound reply sync) — optional per sender
  imap_enabled boolean default false,
  imap_host text,
  imap_user text,
  imap_password text,
  imap_port integer default 993,
  -- sending controls
  daily_limit integer not null default 50,
  signature text,
  is_active boolean not null default true,
  is_default boolean not null default false,
  group_id uuid references public.sender_groups(id) on delete set null,
  auto_paused_at timestamptz,
  auto_paused_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_sender_accounts_updated before update on public.email_sender_accounts
  for each row execute function public.update_updated_at_column();

-- ── Audiences (lead lists) ──────────────────────────────────────────────────
create table if not exists public.outreach_audiences (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  color text default '#BA7517',
  contact_count integer default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create trigger trg_audiences_updated before update on public.outreach_audiences
  for each row execute function public.update_updated_at_column();

-- ── Contacts (GENERAL BUSINESS profile — Google Maps scrape shape) ──────────
-- Replaces the real-estate / influencer contact. Curated columns mirror the
-- common CSV fields; `business_data` keeps the full original record (evidence
-- URLs, context text, ai_* fields, matched queries, etc.) losslessly.
create table if not exists public.outreach_contacts (
  id uuid primary key default gen_random_uuid(),
  audience_id uuid references public.outreach_audiences(id) on delete set null,
  -- identity
  name text not null,                       -- business name  ({{business_name}})
  email text not null,                      -- primary_email
  all_emails text[],                        -- emails[]
  -- classification
  primary_category text,                    -- primary_category  ({{category}})
  categories text[],                        -- categories
  -- contact channels
  phone text,
  website_url text,                         -- website  ({{website}})
  domain text,
  -- location
  address text,
  city text,
  state text,
  postal_code text,
  country_code text,
  latitude double precision,
  longitude double precision,
  -- reputation
  rating double precision,
  review_count integer,
  -- provenance
  maps_url text,
  place_id text,
  cid text,
  source text default 'import',
  -- outreach workflow
  status text not null default 'new'
    check (status in ('new','contacted','replied','interested','customer','rejected','unsubscribed')),
  notes text,
  tags text[],
  last_contacted_at timestamptz,
  -- lossless catch-all for every remaining scrape field
  business_data jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (email)
);
create index if not exists idx_contacts_audience on public.outreach_contacts(audience_id);
create index if not exists idx_contacts_status   on public.outreach_contacts(status);
create index if not exists idx_contacts_city      on public.outreach_contacts(city);
create trigger trg_contacts_updated before update on public.outreach_contacts
  for each row execute function public.update_updated_at_column();

-- Keep audience.contact_count in sync.
create or replace function public.sync_audience_contact_count()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.audience_id is not null then
      update public.outreach_audiences set contact_count = contact_count + 1 where id = new.audience_id;
    end if;
  elsif tg_op = 'DELETE' then
    if old.audience_id is not null then
      update public.outreach_audiences set contact_count = greatest(contact_count - 1, 0) where id = old.audience_id;
    end if;
  elsif tg_op = 'UPDATE' and coalesce(new.audience_id::text,'') <> coalesce(old.audience_id::text,'') then
    if old.audience_id is not null then
      update public.outreach_audiences set contact_count = greatest(contact_count - 1, 0) where id = old.audience_id;
    end if;
    if new.audience_id is not null then
      update public.outreach_audiences set contact_count = contact_count + 1 where id = new.audience_id;
    end if;
  end if;
  return null;
end; $$;
create trigger trg_contacts_count
  after insert or delete or update of audience_id on public.outreach_contacts
  for each row execute function public.sync_audience_contact_count();

-- ── Tags ────────────────────────────────────────────────────────────────────
create table if not exists public.outreach_tags (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  color text not null default '#BA7517',
  created_at timestamptz not null default now()
);
create table if not exists public.contact_tags (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.outreach_contacts(id) on delete cascade,
  tag_id uuid not null references public.outreach_tags(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (contact_id, tag_id)
);

-- ── Templates ───────────────────────────────────────────────────────────────
create table if not exists public.outreach_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  subject text not null,
  body_html text not null,
  body_text text,
  email_format text not null default 'html',
  include_unsubscribe boolean not null default true,
  track_opens boolean not null default true,
  track_clicks boolean not null default true,
  tracking_image_url text,
  system_key text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create trigger trg_templates_updated before update on public.outreach_templates
  for each row execute function public.update_updated_at_column();

-- ── Campaigns ───────────────────────────────────────────────────────────────
create table if not exists public.outreach_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  subject text not null,
  body_html text not null,
  body_text text,
  sender_account_id uuid references public.email_sender_accounts(id),
  sender_group_id uuid references public.sender_groups(id),
  audience_id uuid references public.outreach_audiences(id),
  contact_ids uuid[],
  contact_emails text[],
  email_format text not null default 'html',
  include_unsubscribe boolean not null default true,
  track_opens boolean not null default true,
  track_clicks boolean not null default true,
  track_replies boolean default true,
  tracking_image_url text,
  status text default 'draft' check (status in ('draft','scheduled','sending','sent','paused')),
  scheduled_at timestamptz,
  sent_at timestamptz,
  total_recipients integer default 0,
  sent_count integer default 0,
  open_count integer default 0,
  click_count integer default 0,
  reply_count integer default 0,
  parent_campaign_id uuid references public.outreach_campaigns(id),
  follow_up_segment text check (follow_up_segment in ('all','opened','clicked')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create trigger trg_campaigns_updated before update on public.outreach_campaigns
  for each row execute function public.update_updated_at_column();

-- ── Replies (thread log) ────────────────────────────────────────────────────
create table if not exists public.outreach_replies (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references public.outreach_contacts(id),
  campaign_id uuid references public.outreach_campaigns(id),
  queue_item_id uuid,
  direction text not null default 'inbound' check (direction in ('inbound','outbound')),
  subject text,
  body text,
  replied_at timestamptz default now(),
  created_at timestamptz default now()
);

-- ── Unsubscribes ────────────────────────────────────────────────────────────
create table if not exists public.outreach_unsubscribes (
  email text primary key,
  contact_id uuid references public.outreach_contacts(id),
  unsubscribed_at timestamptz default now()
);

-- ── Deliverability guard settings (single row) ──────────────────────────────
create table if not exists public.outreach_guard_settings (
  id integer primary key default 1,
  enabled boolean not null default true,
  lookback_days integer not null default 7,
  min_sample integer not null default 50,
  threshold_pct double precision not null default 5.0
);
insert into public.outreach_guard_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.email_blacklist (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  reason text,
  added_by uuid,
  created_at timestamptz not null default now()
);

-- ── Send queue ──────────────────────────────────────────────────────────────
create table if not exists public.email_queue (
  id uuid primary key default gen_random_uuid(),
  recipient_email text not null,
  recipient_name text,
  subject text not null,
  html_body text not null,
  email_format text not null default 'html',
  include_unsubscribe boolean not null default true,
  track_opens boolean not null default true,
  tracking_image_url text,
  tracking_token text not null default replace(gen_random_uuid()::text, '-', ''),
  sender_account_id uuid references public.email_sender_accounts(id),
  -- linkage
  campaign_id uuid,                          -- legacy/no FK
  outreach_campaign_id uuid references public.outreach_campaigns(id),
  outreach_contact_id uuid references public.outreach_contacts(id),
  flow_id uuid,
  flow_node_id text,
  template_id text,
  queue_type text default 'outreach' check (queue_type in ('campaign','outreach')),
  -- threading
  in_reply_to text,
  references_header text,
  -- lifecycle
  status text not null default 'pending' check (status in ('pending','sending','sent','failed','cancelled')),
  attempts integer not null default 0,
  error_message text,
  scheduled_for timestamptz not null default now(),
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_queue_status_sched on public.email_queue(status, scheduled_for);
create index if not exists idx_queue_outreach_campaign on public.email_queue(outreach_campaign_id);
create index if not exists idx_queue_template on public.email_queue(template_id) where template_id is not null;

-- ── Tracking events ─────────────────────────────────────────────────────────
create table if not exists public.email_events (
  id uuid primary key default gen_random_uuid(),
  queue_item_id uuid not null references public.email_queue(id) on delete cascade,
  campaign_id uuid,
  recipient_email text not null,
  event_type text not null check (event_type in ('open','click','bounce','complaint')),
  link_id text,
  link_url text,
  user_agent text,
  ip_address text,
  created_at timestamptz not null default now()
);
create index if not exists idx_events_queue on public.email_events(queue_item_id);
create index if not exists idx_events_type  on public.email_events(event_type);

-- ── Flows (visual builder) ──────────────────────────────────────────────────
create table if not exists public.email_flows (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  domain text not null default 'outreach',
  is_active boolean not null default false,
  trigger_type text not null default 'manual',
  trigger_config jsonb,
  nodes_json jsonb,
  edges_json jsonb,
  sender_account_id uuid references public.email_sender_accounts(id),
  sender_group_id uuid references public.sender_groups(id),
  ignore_contacted boolean not null default true,
  send_interval_seconds integer default 60,
  next_send_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_flows_updated before update on public.email_flows
  for each row execute function public.update_updated_at_column();

create table if not exists public.email_flow_enrollments (
  id uuid primary key default gen_random_uuid(),
  flow_id uuid not null references public.email_flows(id) on delete cascade,
  domain text not null default 'outreach',
  subject_type text not null default 'contact',
  contact_id uuid references public.outreach_contacts(id) on delete cascade,
  user_id uuid,
  email text not null,
  current_node_id text,
  status text not null default 'active',
  context jsonb not null default '{}'::jsonb,
  assigned_sender_account_id uuid references public.email_sender_accounts(id),
  last_queue_item_id uuid,
  entered_at timestamptz not null default now(),
  next_run_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_enroll_due on public.email_flow_enrollments(status, next_run_at);
create index if not exists idx_enroll_flow on public.email_flow_enrollments(flow_id);
create trigger trg_enroll_updated before update on public.email_flow_enrollments
  for each row execute function public.update_updated_at_column();

create table if not exists public.email_flow_ab_counter (
  flow_id uuid not null references public.email_flows(id) on delete cascade,
  node_id text not null,
  sent_a integer not null default 0,
  sent_b integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (flow_id, node_id)
);

-- ── Shadow mailbox (unified inbox/outbox) ───────────────────────────────────
create table if not exists public.mailbox_messages (
  id uuid primary key default gen_random_uuid(),
  direction text not null check (direction in ('inbound','outbound')),
  contact_id uuid references public.outreach_contacts(id) on delete set null,
  queue_item_id uuid,
  thread_key text,
  message_id text,
  in_reply_to text,
  from_email text,
  from_name text,
  to_email text,
  subject text,
  snippet text,
  body_text text,
  body_html text,
  seen boolean not null default false,
  archived_at timestamptz,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists idx_mailbox_thread on public.mailbox_messages(thread_key);
create index if not exists idx_mailbox_contact on public.mailbox_messages(contact_id);

-- ============================================================================
-- Functions (RPC)
-- ============================================================================
create or replace function public.increment_outreach_open(campaign_id uuid)
returns void language sql security definer set search_path = public as $$
  update public.outreach_campaigns set open_count = coalesce(open_count,0)+1 where id = campaign_id;
$$;

create or replace function public.increment_outreach_sent(campaign_id uuid)
returns void language sql security definer set search_path = public as $$
  update public.outreach_campaigns set sent_count = coalesce(sent_count,0)+1 where id = campaign_id;
$$;

-- A/B: continuous even 50/50 split — always feed whichever variant is behind.
create or replace function public.ab_assign(p_flow uuid, p_node text, p_test_size integer)
returns text language plpgsql security definer set search_path = public as $$
declare a int; b int; pick text;
begin
  insert into public.email_flow_ab_counter (flow_id, node_id) values (p_flow, p_node)
    on conflict (flow_id, node_id) do nothing;
  select sent_a, sent_b into a, b from public.email_flow_ab_counter
    where flow_id = p_flow and node_id = p_node for update;
  if a <= b then
    update public.email_flow_ab_counter set sent_a = sent_a + 1, updated_at = now()
      where flow_id = p_flow and node_id = p_node; pick := 'A';
  else
    update public.email_flow_ab_counter set sent_b = sent_b + 1, updated_at = now()
      where flow_id = p_flow and node_id = p_node; pick := 'B';
  end if;
  return pick;
end; $$;

-- Per-template performance across flows + campaigns, optionally filtered by tag.
create or replace function public.template_performance(p_tag uuid default null)
returns table(template_id text, template_name text, sends bigint, replies bigint)
language sql security definer set search_path = public as $$
  with tagged as (
    select contact_id from public.contact_tags where p_tag is not null and tag_id = p_tag
  ),
  sends as (
    select q.template_id, count(*) as n
    from public.email_queue q
    where q.template_id is not null and q.status = 'sent'
      and (p_tag is null or q.outreach_contact_id in (select contact_id from tagged))
    group by q.template_id
  ),
  last_out as (
    select distinct on (m.thread_key) m.thread_key, q.template_id, q.outreach_contact_id
    from public.mailbox_messages m
    join public.email_queue q on q.id = m.queue_item_id
    where m.direction = 'outbound' and q.template_id is not null
    order by m.thread_key, m.occurred_at desc
  ),
  replied as (
    select distinct thread_key from public.mailbox_messages
    where direction = 'inbound'
  ),
  reply_counts as (
    select lo.template_id, count(*) as n
    from last_out lo join replied r on r.thread_key = lo.thread_key
    where (p_tag is null or lo.outreach_contact_id in (select contact_id from tagged))
    group by lo.template_id
  )
  select t.id::text, t.name, coalesce(s.n,0), coalesce(rc.n,0)
  from public.outreach_templates t
  left join sends s on s.template_id = t.id::text
  left join reply_counts rc on rc.template_id = t.id::text
  where coalesce(s.n,0) > 0 or coalesce(rc.n,0) > 0
  order by coalesce(rc.n,0) desc, coalesce(s.n,0) desc;
$$;

-- ============================================================================
-- Row Level Security — admin manages everything; workers use service_role.
-- ============================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'sender_groups','email_sender_accounts','outreach_audiences','outreach_contacts',
    'outreach_tags','contact_tags','outreach_templates','outreach_campaigns',
    'outreach_replies','outreach_guard_settings','email_blacklist','email_queue',
    'email_events','email_flows','email_flow_enrollments','email_flow_ab_counter',
    'mailbox_messages'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format($p$create policy "admins all %1$s" on public.%1$I for all
      using (public.has_role(auth.uid(), 'admin'))
      with check (public.has_role(auth.uid(), 'admin'));$p$, t);
  end loop;
end $$;

-- Unsubscribe endpoint is public (recipients click a link with no session).
alter table public.outreach_unsubscribes enable row level security;
create policy "admins read unsubscribes" on public.outreach_unsubscribes for select
  using (public.has_role(auth.uid(), 'admin'));
create policy "public insert unsubscribes" on public.outreach_unsubscribes for insert
  with check (true);

-- ============================================================================
-- Seed
-- ============================================================================
insert into public.sender_groups (name, is_default) values ('Default', true)
  on conflict do nothing;

-- ============================================================================
-- Scheduling note: the send queue, flow tick and IMAP reply sync are driven by
-- Netlify Scheduled Functions (see netlify.toml), which call the worker
-- functions every minute. No pg_cron jobs are needed here.
-- ============================================================================
