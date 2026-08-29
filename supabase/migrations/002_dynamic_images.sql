-- Personalised image generation (PSD -> per-recipient PNG).
--
-- A source file (.psd) is uploaded once as an "image template". Its text layers
-- are scanned and mapped to merge tags. At queue time we freeze the exact strings
-- for that recipient into email_queue.render_spec; the LOCAL renderer then draws
-- the PNG, uploads it, rewrites the email body with the public URL, and flips
-- render_status to 'done'. The send worker never sends a row still awaiting art.

-- ── Image templates ─────────────────────────────────────────────────────────
create table if not exists public.image_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  storage_path text not null,              -- object path in the 'image-templates' bucket
  file_kind text not null default 'psd',   -- psd (room for svg/ai later)
  width integer,
  height integer,
  layers jsonb not null default '[]'::jsonb,   -- scan result: editable text layers
  mapping jsonb not null default '{}'::jsonb,  -- { layerId: "merge_tag" }
  preview_url text,                        -- last preview render, for the UI
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_image_templates_updated before update on public.image_templates
  for each row execute function public.update_updated_at_column();

-- An email template can carry one personalised image.
alter table public.outreach_templates
  add column if not exists image_template_id uuid references public.image_templates(id) on delete set null;

-- ── Render cache ────────────────────────────────────────────────────────────
-- Same template + same values => reuse the PNG instead of regenerating it.
create table if not exists public.image_renders (
  id uuid primary key default gen_random_uuid(),
  image_template_id uuid not null references public.image_templates(id) on delete cascade,
  value_hash text not null,
  url text not null,
  created_at timestamptz not null default now(),
  unique (image_template_id, value_hash)
);
create index if not exists idx_image_renders_lookup on public.image_renders(image_template_id, value_hash);

-- ── Queue: rows that need art before they may be sent ───────────────────────
alter table public.email_queue
  add column if not exists render_status text
    check (render_status is null or render_status in ('pending','done','failed')),
  add column if not exists render_spec jsonb,
  add column if not exists render_url text;

-- The drain worker filters on this, so keep it cheap.
create index if not exists idx_email_queue_render_pending
  on public.email_queue(render_status) where render_status = 'pending';

-- ── RLS: admin-managed, same as everything else ─────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['image_templates','image_renders'] loop
    execute format('alter table public.%I enable row level security;', t);
    begin
      execute format($p$create policy "admins all %1$s" on public.%1$I for all
        using (public.has_role(auth.uid(), 'admin'))
        with check (public.has_role(auth.uid(), 'admin'));$p$, t);
    exception when duplicate_object then null; end;
  end loop;
end $$;

-- ── Storage buckets ─────────────────────────────────────────────────────────
-- 'image-templates' holds the source .psd files (private).
-- 'renders' holds the generated PNGs and MUST be public: the recipient's mail
-- client fetches the image with no session.
insert into storage.buckets (id, name, public)
  values ('image-templates', 'image-templates', false)
  on conflict (id) do nothing;
insert into storage.buckets (id, name, public)
  values ('renders', 'renders', true)
  on conflict (id) do update set public = true;
