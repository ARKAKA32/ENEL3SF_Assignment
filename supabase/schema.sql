-- Sentry: Emergency Incident Reporting Application
-- Schema matches the report's Database Design section (Table 1-5),
-- with three naming fixes applied: assigned_to, created_at, longitude.

create extension if not exists "pgcrypto";

-- ---------- Table 1: users ----------
-- Extends Supabase's built-in auth.users with app-specific profile data.
create table public.users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  name varchar,
  email varchar unique,
  phone varchar,
  role varchar not null default 'civilian' check (role in ('civilian','operator','responder','admin')),
  account_status varchar not null default 'active' check (account_status in ('active','suspended','disabled')),
  created_at timestamptz not null default now()
);

-- Auto-create a profile row whenever someone signs up via Supabase Auth.
create function public.handle_new_user()
returns trigger as $$
begin
  insert into public.users (user_id, name, email)
  values (new.id, new.raw_user_meta_data->>'name', new.email);
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------- Table 2: incidents ----------
create table public.incidents (
  incident_id uuid primary key default gen_random_uuid(),
  reporter_id uuid references public.users(user_id),
  title varchar,
  description text not null,
  category varchar check (category in ('fire','police','medical','child_services','other')),
  severity varchar check (severity in ('low','medium','high','critical')),
  status varchar not null default 'new' check (status in ('new','acknowledged','assigned','in_progress','resolved','closed')),
  latitude decimal,
  longitude decimal,
  location_source varchar check (location_source in ('gps','manual')),
  is_anon boolean not null default false,
  assigned_to uuid references public.users(user_id),
  master_incident_id uuid references public.incidents(incident_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- ---------- Table 3: incident_updates ----------
create table public.incident_updates (
  update_id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.incidents(incident_id),
  user_id uuid references public.users(user_id),
  update_type varchar not null check (update_type in ('STATUS_CHANGE','NOTE','ASSIGNMENT','SEVERITY_CHANGE','MERGE')),
  old_status varchar,
  new_status varchar,
  note text,
  created_at timestamptz not null default now()
);

-- ---------- Table 4: incident_media ----------
create table public.incident_media (
  media_id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.incidents(incident_id),
  file_url text not null,
  file_type varchar not null default 'image',
  file_size integer,
  uploaded_at timestamptz not null default now()
);

-- ---------- Table 5: notifications ----------
create table public.notifications (
  notification_id uuid primary key default gen_random_uuid(),
  incident_id uuid references public.incidents(incident_id),
  created_by uuid references public.users(user_id),
  title varchar not null,
  message text not null,
  notification_type varchar not null check (notification_type in ('ADMIN_ALERT','PUBLIC_BROADCAST')),
  latitude decimal,
  longitude decimal,
  radius_km decimal,
  severity varchar,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);

-- ================= Row-Level Security =================

alter table public.users enable row level security;
alter table public.incidents enable row level security;
alter table public.incident_updates enable row level security;
alter table public.incident_media enable row level security;
alter table public.notifications enable row level security;

-- Helper: is the current user an operator/admin?
create function public.is_staff()
returns boolean as $$
  select exists (
    select 1 from public.users
    where user_id = auth.uid() and role in ('operator','responder','admin')
  );
$$ language sql security definer stable;

-- users: people can read their own profile; staff can read all
create policy "read own profile" on public.users for select using (auth.uid() = user_id);
create policy "staff read all profiles" on public.users for select using (public.is_staff());

-- incidents: anyone (including anonymous) can submit a report
create policy "anyone can submit incidents" on public.incidents
  for insert with check (true);

-- incidents: staff can read everything; a reporter can read their own report
create policy "staff read all incidents" on public.incidents
  for select using (public.is_staff());
create policy "reporter reads own incident" on public.incidents
  for select using (auth.uid() = reporter_id);

-- incidents: only staff may update (status, assignment, classification results)
create policy "staff update incidents" on public.incidents
  for update using (public.is_staff());

-- incident_updates: only staff may insert or read update history
create policy "staff manage incident updates" on public.incident_updates
  for all using (public.is_staff()) with check (public.is_staff());

-- incident_media: anyone may attach media to a report they're submitting;
-- staff can read all
create policy "anyone can attach media" on public.incident_media
  for insert with check (true);
create policy "staff read all media" on public.incident_media
  for select using (public.is_staff());

-- notifications: staff manage; everyone can read active public broadcasts
create policy "staff manage notifications" on public.notifications
  for all using (public.is_staff()) with check (public.is_staff());
create policy "anyone reads public broadcasts" on public.notifications
  for select using (notification_type = 'PUBLIC_BROADCAST');

-- ================= Realtime =================
-- Enable realtime so the operator dashboard gets live updates (Requirement: 1.0s propagation NFR)
alter publication supabase_realtime add table public.incidents;
alter publication supabase_realtime add table public.incident_updates;
