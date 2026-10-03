-- Apply to the existing schema.sql database. No reports are deleted or reseeded.
begin;
alter table public.incidents add column if not exists location_text text;
alter table public.incident_updates add column if not exists is_public boolean not null default false;
alter table public.incident_updates drop constraint if exists incident_updates_update_type_check;
alter table public.incident_updates add constraint incident_updates_update_type_check check (update_type in ('STATUS_CHANGE','NOTE','ASSIGNMENT','SEVERITY_CHANGE','CATEGORY_CHANGE','MERGE'));
create index if not exists incidents_reporter_created_idx on public.incidents(reporter_id, created_at desc);
create index if not exists incident_updates_incident_created_idx on public.incident_updates(incident_id, created_at desc);
create index if not exists incident_media_incident_idx on public.incident_media(incident_id);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.users(user_id, name, email) values (new.id, new.raw_user_meta_data->>'name', new.email) on conflict (user_id) do nothing;
  return new;
end;
$$;
-- Fill missing profiles for existing Auth accounts; existing roles are preserved.
insert into public.users(user_id, name, email)
select id, raw_user_meta_data->>'name', email from auth.users on conflict (user_id) do nothing;
create or replace function public.is_staff() returns boolean
language sql security definer stable set search_path = public, pg_temp as $$
  select exists(select 1 from public.users where user_id = auth.uid() and account_status = 'active' and role in ('operator','responder','admin'));
$$;
create or replace function public.is_active_user() returns boolean
language sql security definer stable set search_path = public, pg_temp as $$
  select exists(select 1 from public.users where user_id = auth.uid() and account_status = 'active');
$$;

-- Replace old permissive policies; writes now use the validated server or the atomic RPC.
do $$ declare p record; begin
  for p in select tablename, policyname from pg_policies where schemaname = 'public' and tablename in ('users','incidents','incident_updates','incident_media','notifications') loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;
revoke all on public.users, public.incidents, public.incident_updates, public.incident_media, public.notifications from anon, authenticated;
grant select on public.users, public.incidents, public.incident_updates, public.incident_media, public.notifications to authenticated;
grant select on public.notifications to anon;
create policy "profiles visible to owner and active staff" on public.users for select to authenticated using (user_id = auth.uid() or public.is_staff());
create policy "incidents visible to staff or identified owner" on public.incidents for select to authenticated using (public.is_staff() or (public.is_active_user() and not is_anon and reporter_id = auth.uid()));
create policy "history visible to staff or public owner" on public.incident_updates for select to authenticated using (public.is_staff() or (is_public and exists(select 1 from public.incidents i where i.incident_id = incident_updates.incident_id and not i.is_anon and i.reporter_id = auth.uid() and public.is_active_user())));
create policy "media visible to staff or owner" on public.incident_media for select to authenticated using (public.is_staff() or exists(select 1 from public.incidents i where i.incident_id = incident_media.incident_id and not i.is_anon and i.reporter_id = auth.uid() and public.is_active_user()));
create policy "staff see notifications" on public.notifications for select to authenticated using (public.is_staff());
create policy "active public broadcasts" on public.notifications for select to anon, authenticated using (notification_type = 'PUBLIC_BROADCAST' and (expires_at is null or expires_at > now()));

create table if not exists public.push_subscriptions (
  subscription_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(user_id) on delete cascade,
  endpoint text not null unique,
  keys jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions(user_id);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;
-- These grants are explicit because projects may have customised default privileges.
grant all on public.users, public.incidents, public.incident_updates, public.incident_media, public.notifications, public.push_subscriptions to service_role;

-- Images remain private. Only the server writes objects and issues short-lived URLs.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('incident-media','incident-media',false,5242880,array['image/jpeg','image/png'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.save_incident_update(
  p_id uuid, p_status text, p_category text, p_severity text, p_assigned_to uuid,
  p_note text, p_is_public boolean, p_expected_updated_at timestamptz
) returns public.incidents
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  actor public.users;
  original public.incidents;
  saved public.incidents;
begin
  select * into actor from public.users where user_id = auth.uid();
  if actor.user_id is null or actor.account_status <> 'active' or actor.role not in ('operator','responder','admin') then
    raise exception 'Staff access required.' using errcode = '42501';
  end if;
  select * into original from public.incidents where incident_id = p_id for update;
  if not found then raise exception 'Incident not found.' using errcode = '22023'; end if;
  if p_expected_updated_at is null or original.updated_at <> p_expected_updated_at then
    raise exception 'Another staff member updated this incident. Refresh it before saving.' using errcode = '40001';
  end if;
  if p_status is null or p_status not in ('new','acknowledged','assigned','in_progress','resolved','closed') or
    (p_category is not null and p_category not in ('fire','police','medical','child_services','other')) or
    (p_severity is not null and p_severity not in ('low','medium','high','critical')) or
    p_note is null or length(p_note) > 2000 or p_is_public is null then
    raise exception 'Invalid incident update.' using errcode = '22023';
  end if;
  if p_assigned_to is distinct from original.assigned_to and actor.role <> 'admin' then
    raise exception 'Only admins can change assignments.' using errcode = '42501';
  end if;
  if p_assigned_to is not null and p_assigned_to is distinct from original.assigned_to and not exists (
    select 1 from public.users where user_id = p_assigned_to and account_status = 'active' and role in ('operator','responder','admin')
  ) then raise exception 'Select an active staff member.' using errcode = '22023'; end if;
  if p_status = 'assigned' and p_assigned_to is null then
    raise exception 'Choose an assignee before marking an incident Assigned.' using errcode = '22023';
  end if;
  if p_status = original.status and p_category is not distinct from original.category and p_severity is not distinct from original.severity and p_assigned_to is not distinct from original.assigned_to and btrim(p_note) = '' then return original; end if;
  update public.incidents set status = p_status, category = p_category, severity = p_severity,
    assigned_to = p_assigned_to, updated_at = clock_timestamp(),
    resolved_at = case when p_status in ('resolved','closed') then coalesce(original.resolved_at,now()) else null end
  where incident_id = p_id returning * into saved;
  if p_status <> original.status then
    insert into public.incident_updates(incident_id,user_id,update_type,old_status,new_status,is_public)
    values(p_id,actor.user_id,'STATUS_CHANGE',original.status,p_status,true);
  end if;
  if p_category is distinct from original.category then
    insert into public.incident_updates(incident_id,user_id,update_type,note,is_public)
    values(p_id,actor.user_id,'CATEGORY_CHANGE',coalesce(original.category,'Pending') || ' → ' || coalesce(p_category,'Pending'),true);
  end if;
  if p_severity is distinct from original.severity then
    insert into public.incident_updates(incident_id,user_id,update_type,note,is_public)
    values(p_id,actor.user_id,'SEVERITY_CHANGE',coalesce(original.severity,'Pending') || ' → ' || coalesce(p_severity,'Pending'),true);
  end if;
  if p_assigned_to is distinct from original.assigned_to then
    insert into public.incident_updates(incident_id,user_id,update_type,note,is_public)
    values(p_id,actor.user_id,'ASSIGNMENT',case when p_assigned_to is null then 'Assignment cleared' else 'Assigned to ' || coalesce((select coalesce(name,email) from public.users where user_id = p_assigned_to),p_assigned_to::text) end,false);
  end if;
  if btrim(p_note) <> '' then
    insert into public.incident_updates(incident_id,user_id,update_type,note,is_public)
    values(p_id,actor.user_id,'NOTE',btrim(p_note),p_is_public);
  end if;
  return saved;
end;
$$;
revoke all on function public.save_incident_update(uuid,text,text,text,uuid,text,boolean,timestamptz) from public;
grant execute on function public.save_incident_update(uuid,text,text,text,uuid,text,boolean,timestamptz) to authenticated;
revoke all on function public.handle_new_user() from public;

-- Idempotently add read feeds to Supabase Realtime.
do $$ declare table_name text; begin
  foreach table_name in array array['incidents','incident_updates','incident_media','notifications'] loop
    if not exists(select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = table_name) then
      execute format('alter publication supabase_realtime add table public.%I', table_name);
    end if;
  end loop;
end $$;
commit;
