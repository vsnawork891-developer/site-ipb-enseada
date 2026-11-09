-- Etapa 10: grupos, escalas, repertórios e biblioteca musical estruturada.
-- Execute depois das migrations das etapas 8 e 9.

create extension if not exists pgcrypto;

alter table public.ministry_groups
  add column if not exists service_weekday smallint not null default 0 check (service_weekday between 0 and 6);

insert into public.ministry_groups (name, is_active)
select seed.name, true
from (values ('Culto Público'), ('Culto de Oração'), ('EBD')) as seed(name)
where not exists (select 1 from public.ministry_groups g where lower(g.name) = lower(seed.name));

update public.ministry_groups set service_weekday = 4 where lower(name) = lower('Culto de Oração');
update public.ministry_groups set service_weekday = 0 where lower(name) in (lower('Culto Público'), lower('EBD'));

create table if not exists public.songs_catalog (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(trim(title)) between 1 and 200),
  artist text not null default '',
  composer text not null default '',
  male_key text not null default '',
  female_key text not null default '',
  chart_url text not null default '',
  youtube_url text not null default '',
  themes text not null default '',
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists songs_catalog_title_idx on public.songs_catalog using gin (to_tsvector('simple', title || ' ' || artist || ' ' || composer || ' ' || themes));

create table if not exists public.worship_services (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.ministry_groups(id) on delete restrict,
  service_date date not null,
  theme text not null default '',
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (group_id, service_date)
);
create index if not exists worship_services_group_date_idx on public.worship_services (group_id, service_date desc);

create table if not exists public.service_people (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null references public.worship_services(id) on delete cascade,
  role text not null check (role in ('singer', 'musician')),
  name text not null check (char_length(trim(name)) between 1 and 120),
  position integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists service_people_service_idx on public.service_people (service_id, role, position);

create table if not exists public.service_songs (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null references public.worship_services(id) on delete cascade,
  song_id uuid references public.songs_catalog(id) on delete set null,
  title_snapshot text not null check (char_length(trim(title_snapshot)) between 1 and 200),
  artist_snapshot text not null default '',
  soloist text not null default '',
  male_key_snapshot text not null default '',
  female_key_snapshot text not null default '',
  youtube_url_snapshot text not null default '',
  chart_url_snapshot text not null default '',
  position integer not null check (position between 1 and 8),
  created_at timestamptz not null default now(),
  unique (service_id, position)
);
create index if not exists service_songs_service_idx on public.service_songs (service_id, position);

create table if not exists public.service_snapshots (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null references public.worship_services(id) on delete cascade,
  snapshot jsonb not null,
  changed_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

alter table public.songs_catalog enable row level security;
alter table public.worship_services enable row level security;
alter table public.service_people enable row level security;
alter table public.service_songs enable row level security;
alter table public.service_snapshots enable row level security;

revoke all on public.songs_catalog, public.worship_services, public.service_people, public.service_songs, public.service_snapshots from anon, authenticated;
grant select, insert, update, delete on public.songs_catalog, public.worship_services, public.service_people, public.service_songs, public.service_snapshots to service_role;
grant select on public.ministry_groups to service_role;
grant select, insert, update, delete on public.ministry_groups to service_role;
grant select, insert, update, delete on public.group_memberships to service_role;
grant select, insert, update, delete on public.profiles, public.system_permissions to service_role;

create or replace function public.panel_save_service(
  p_service_id uuid,
  p_group_id uuid,
  p_service_date date,
  p_theme text,
  p_actor uuid,
  p_people jsonb,
  p_songs jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_snapshot jsonb;
  v_row jsonb;
  v_position integer;
begin
  if jsonb_typeof(coalesce(p_songs, '[]'::jsonb)) <> 'array' then
    raise exception 'A lista de músicas é inválida.' using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(p_songs, '[]'::jsonb)) > 8 then
    raise exception 'A escala aceita no máximo oito músicas.' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_people, '[]'::jsonb)) <> 'array' then
    raise exception 'A lista de participantes é inválida.' using errcode = '22023';
  end if;

  if p_service_id is null then
    insert into public.worship_services (group_id, service_date, theme, created_by, updated_by)
    values (p_group_id, p_service_date, coalesce(p_theme, ''), p_actor, p_actor)
    returning id into v_id;
  else
    select to_jsonb(s) || jsonb_build_object(
      'people', coalesce((select jsonb_agg(to_jsonb(sp) order by sp.role, sp.position) from public.service_people sp where sp.service_id = s.id), '[]'::jsonb),
      'songs', coalesce((select jsonb_agg(to_jsonb(ss) order by ss.position) from public.service_songs ss where ss.service_id = s.id), '[]'::jsonb)
    ) into v_snapshot
    from public.worship_services s where s.id = p_service_id for update;
    if v_snapshot is null then raise exception 'Escala não encontrada.' using errcode = 'P0002'; end if;
    insert into public.service_snapshots (service_id, snapshot, changed_by)
    values (p_service_id, v_snapshot, p_actor);
    update public.worship_services
       set group_id = p_group_id, service_date = p_service_date, theme = coalesce(p_theme, ''), updated_by = p_actor, updated_at = now()
     where id = p_service_id;
    v_id := p_service_id;
    delete from public.service_people where service_id = v_id;
    delete from public.service_songs where service_id = v_id;
  end if;

  for v_row in select value from jsonb_array_elements(coalesce(p_people, '[]'::jsonb)) loop
    if nullif(trim(v_row->>'name'), '') is not null then
      insert into public.service_people (service_id, role, name, position)
      values (v_id, case when v_row->>'role' = 'musician' then 'musician' else 'singer' end, left(trim(v_row->>'name'), 120), coalesce((v_row->>'position')::integer, 0));
    end if;
  end loop;

  for v_row, v_position in select entries.value, entries.position::integer from jsonb_array_elements(coalesce(p_songs, '[]'::jsonb)) with ordinality as entries(value, position) loop
    insert into public.service_songs (service_id, song_id, title_snapshot, artist_snapshot, soloist, male_key_snapshot, female_key_snapshot, youtube_url_snapshot, chart_url_snapshot, position)
    values (
      v_id,
      nullif(v_row->>'song_id', '')::uuid,
      left(trim(v_row->>'title_snapshot'), 200),
      left(coalesce(v_row->>'artist_snapshot', ''), 200),
      left(coalesce(v_row->>'soloist', ''), 200),
      left(coalesce(v_row->>'male_key_snapshot', ''), 40),
      left(coalesce(v_row->>'female_key_snapshot', ''), 40),
      left(coalesce(v_row->>'youtube_url_snapshot', ''), 1000),
      left(coalesce(v_row->>'chart_url_snapshot', ''), 1000),
      v_position
    );
  end loop;
  return v_id;
end;
$$;

revoke all on function public.panel_save_service(uuid, uuid, date, text, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.panel_save_service(uuid, uuid, date, text, uuid, jsonb, jsonb) to service_role;
