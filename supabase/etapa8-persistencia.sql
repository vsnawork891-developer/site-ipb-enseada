-- Etapa 8: persistência do catálogo, snapshots e notas pessoais.
-- Execute no Supabase SQL Editor uma única vez antes de publicar o frontend.
-- As tabelas de apoio profiles, system_permissions, ministry_groups e
-- group_memberships são preexistentes e seguem o contrato descrito no README.

create extension if not exists pgcrypto;

-- A API /api/me usa SUPABASE_SECRET_KEY no servidor para montar o contexto.
-- Mantenha estes acessos administrativos limitados ao papel server-side.
grant select, insert, update on table public.profiles to service_role;
grant select on table public.ministry_groups to service_role;
grant select, insert on table public.group_memberships to service_role;
grant select, insert on table public.system_permissions to service_role;
grant usage on schema public to authenticated, service_role;

create table if not exists public.library_items (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(trim(title)) between 1 and 160),
  content text not null default '' check (char_length(content) <= 12000),
  visibility text not null default 'ministry'
    check (visibility in ('ministry', 'groups', 'private')),
  group_ids uuid[] not null default '{}',
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint library_items_groups_required
    check (visibility <> 'groups' or cardinality(group_ids) > 0),
  constraint library_items_groups_only_for_groups
    check (visibility = 'groups' or cardinality(group_ids) = 0)
);

create index if not exists library_items_updated_at_idx
  on public.library_items (updated_at desc);
create index if not exists library_items_visibility_idx
  on public.library_items (visibility);

create table if not exists public.library_item_snapshots (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.library_items(id) on delete cascade,
  title text not null,
  content text not null,
  visibility text not null check (visibility in ('ministry', 'groups', 'private')),
  group_ids uuid[] not null default '{}',
  changed_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create index if not exists library_item_snapshots_item_created_idx
  on public.library_item_snapshots (item_id, created_at desc);

create table if not exists public.personal_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id uuid references public.library_items(id) on delete cascade,
  body text not null default '' check (char_length(body) <= 8000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists personal_notes_item_unique
  on public.personal_notes (user_id, item_id) where item_id is not null;
create unique index if not exists personal_notes_general_unique
  on public.personal_notes (user_id) where item_id is null;

create or replace function public.panel_current_user_active()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_active is true
  );
$$;

create or replace function public.panel_current_user_owner()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_active is true
      and (p.is_owner is true or p.role = 'owner')
  );
$$;

create or replace function public.panel_current_has_permission(permission_key text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select public.panel_current_user_owner() or coalesce((
    select case permission_key
      when 'library_view' then sp.library_view
      when 'library_create' then sp.library_create
      when 'library_edit' then sp.library_edit
      when 'library_delete' then sp.library_delete
      when 'users_view' then sp.users_view
      when 'users_create' then sp.users_create
      when 'users_edit' then sp.users_edit
      when 'users_delete' then sp.users_delete
      when 'groups_view' then sp.groups_view
      when 'groups_create' then sp.groups_create
      when 'groups_edit' then sp.groups_edit
      when 'groups_delete' then sp.groups_delete
      when 'imports_create' then sp.imports_create
      when 'audit_view' then sp.audit_view
      else false
    end
    from public.system_permissions sp
    join public.profiles p on p.id = sp.user_id and p.is_active is true
    where sp.user_id = auth.uid()
    limit 1
  ), false);
$$;

create or replace function public.panel_current_group_can(p_group_id uuid, p_action_key text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select public.panel_current_user_active() and exists (
    select 1 from public.ministry_groups g
    where g.id = p_group_id and g.is_active is true
      and (
        public.panel_current_user_owner()
        or exists (
          select 1 from public.group_memberships gm
          where gm.user_id = auth.uid() and gm.group_id = g.id
            and gm.has_access is true
            and case p_action_key
              when 'view' then gm.can_view
              when 'create' then gm.can_create
              when 'edit' then gm.can_edit
              when 'delete' then gm.can_delete
              else false
            end
        )
      )
  );
$$;

create or replace function public.panel_can_assign_groups(p_group_ids uuid[], p_action_key text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce(bool_and(public.panel_current_group_can(selected.group_id, p_action_key)), true)
  from unnest(coalesce(p_group_ids, '{}'::uuid[])) as selected(group_id);
$$;

create or replace function public.panel_can_view_library_item(p_item_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.library_items i
    where i.id = p_item_id
      and public.panel_current_user_active()
      and (public.panel_current_user_owner() or public.panel_current_has_permission('library_view'))
      and (
        public.panel_current_user_owner()
        or i.created_by = auth.uid()
        or i.visibility = 'ministry'
        or (
          i.visibility = 'groups'
          and exists (
            select 1 from unnest(i.group_ids) as selected(group_id)
            where public.panel_current_group_can(selected.group_id, 'view')
          )
        )
      )
  );
$$;

create or replace function public.panel_can_edit_library_item(p_item_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.library_items i
    where i.id = p_item_id and public.panel_current_user_active()
      and (
        public.panel_current_user_owner()
        or public.panel_current_has_permission('library_edit')
        or (i.created_by = auth.uid() and public.panel_current_has_permission('library_create'))
      )
  );
$$;

create or replace function public.panel_can_delete_library_item(p_item_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.library_items i
    where i.id = p_item_id and public.panel_current_user_active()
      and (
        public.panel_current_user_owner()
        or public.panel_current_has_permission('library_delete')
        or (
          i.created_by = auth.uid()
          and public.panel_current_has_permission('library_create')
          and public.panel_can_assign_groups(i.group_ids, 'delete')
        )
      )
  );
$$;

create or replace function public.panel_touch_library_item()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.updated_by := auth.uid();
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.updated_by := auth.uid();
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create or replace function public.panel_snapshot_library_item()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if old.title is distinct from new.title
     or old.content is distinct from new.content
     or old.visibility is distinct from new.visibility
     or old.group_ids is distinct from new.group_ids then
    insert into public.library_item_snapshots
      (item_id, title, content, visibility, group_ids, changed_by)
    values
      (old.id, old.title, old.content, old.visibility, old.group_ids, auth.uid());
  end if;
  return new;
end;
$$;

create or replace function public.panel_touch_personal_note()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.user_id := auth.uid();
  else
    new.user_id := old.user_id;
    new.item_id := old.item_id;
    new.created_at := old.created_at;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists library_items_touch on public.library_items;
create trigger library_items_touch
before insert or update on public.library_items
for each row execute function public.panel_touch_library_item();

drop trigger if exists library_items_snapshot on public.library_items;
create trigger library_items_snapshot
before update on public.library_items
for each row execute function public.panel_snapshot_library_item();

drop trigger if exists personal_notes_touch on public.personal_notes;
create trigger personal_notes_touch
before insert or update on public.personal_notes
for each row execute function public.panel_touch_personal_note();

alter table public.library_items enable row level security;
alter table public.library_item_snapshots enable row level security;
alter table public.personal_notes enable row level security;

revoke all on table public.library_items, public.library_item_snapshots, public.personal_notes from public, anon, authenticated;
grant select, insert, update, delete on table public.library_items to authenticated;
grant select on table public.library_item_snapshots to authenticated;
grant select, insert, update, delete on table public.personal_notes to authenticated;

drop policy if exists library_items_read on public.library_items;
create policy library_items_read on public.library_items
for select to authenticated
using (public.panel_can_view_library_item(id));

drop policy if exists library_items_create on public.library_items;
create policy library_items_create on public.library_items
for insert to authenticated
with check (
  public.panel_current_user_active()
  and (public.panel_current_user_owner() or public.panel_current_has_permission('library_create'))
  and created_by = auth.uid()
  and public.panel_can_assign_groups(group_ids, 'create')
);

drop policy if exists library_items_edit on public.library_items;
create policy library_items_edit on public.library_items
for update to authenticated
using (public.panel_can_edit_library_item(id))
with check (
  public.panel_can_edit_library_item(id)
  and (
    public.panel_current_user_owner()
    or public.panel_current_has_permission('library_edit')
    or public.panel_can_assign_groups(group_ids, 'edit')
  )
);

drop policy if exists library_items_delete on public.library_items;
create policy library_items_delete on public.library_items
for delete to authenticated
using (public.panel_can_delete_library_item(id));

drop policy if exists library_snapshots_read on public.library_item_snapshots;
create policy library_snapshots_read on public.library_item_snapshots
for select to authenticated
using (public.panel_can_view_library_item(item_id));

drop policy if exists personal_notes_read on public.personal_notes;
create policy personal_notes_read on public.personal_notes
for select to authenticated
using (
  user_id = auth.uid() and public.panel_current_user_active()
  and (item_id is null or public.panel_can_view_library_item(item_id))
);

drop policy if exists personal_notes_create on public.personal_notes;
create policy personal_notes_create on public.personal_notes
for insert to authenticated
with check (
  user_id = auth.uid() and public.panel_current_user_active()
  and (item_id is null or public.panel_can_view_library_item(item_id))
);

drop policy if exists personal_notes_edit on public.personal_notes;
create policy personal_notes_edit on public.personal_notes
for update to authenticated
using (user_id = auth.uid() and public.panel_current_user_active())
with check (
  user_id = auth.uid() and public.panel_current_user_active()
  and (item_id is null or public.panel_can_view_library_item(item_id))
);

drop policy if exists personal_notes_delete on public.personal_notes;
create policy personal_notes_delete on public.personal_notes
for delete to authenticated
using (user_id = auth.uid() and public.panel_current_user_active());

revoke all on function public.panel_current_user_active() from public, anon;
revoke all on function public.panel_current_user_owner() from public, anon;
revoke all on function public.panel_current_has_permission(text) from public, anon;
revoke all on function public.panel_current_group_can(uuid, text) from public, anon;
revoke all on function public.panel_can_assign_groups(uuid[], text) from public, anon;
revoke all on function public.panel_can_view_library_item(uuid) from public, anon;
revoke all on function public.panel_can_edit_library_item(uuid) from public, anon;
revoke all on function public.panel_can_delete_library_item(uuid) from public, anon;
grant execute on function public.panel_current_user_active() to authenticated;
grant execute on function public.panel_current_user_owner() to authenticated;
grant execute on function public.panel_current_has_permission(text) to authenticated;
grant execute on function public.panel_current_group_can(uuid, text) to authenticated;
grant execute on function public.panel_can_assign_groups(uuid[], text) to authenticated;
grant execute on function public.panel_can_view_library_item(uuid) to authenticated;
grant execute on function public.panel_can_edit_library_item(uuid) to authenticated;
grant execute on function public.panel_can_delete_library_item(uuid) to authenticated;
