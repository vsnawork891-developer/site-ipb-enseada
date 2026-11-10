-- Etapa 11: vínculos de integrantes às contas para alimentar Minha agenda.
-- Execute uma vez depois de etapa10-escalas-repertorios.sql.

alter table public.service_people
  add column if not exists profile_id uuid references public.profiles(id) on delete set null;

create index if not exists service_people_profile_idx
  on public.service_people (profile_id, service_id)
  where profile_id is not null;

-- Vincula nomes antigos quando há uma única correspondência sem diferenciar maiúsculas.
-- Nomes ambíguos ou sem cadastro permanecem sem vínculo para revisão manual no painel.
with matches as (
  select sp.id as person_id, min(p.id::text)::uuid as profile_id, count(*) as match_count
  from public.service_people sp
  join public.profiles p on lower(regexp_replace(translate(trim(p.full_name), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc'), '\s+', ' ', 'g')) =
                          lower(regexp_replace(translate(trim(sp.name), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc'), '\s+', ' ', 'g'))
  where sp.profile_id is null
  group by sp.id
)
update public.service_people sp
set profile_id = matches.profile_id
from matches
where sp.id = matches.person_id and matches.match_count = 1;

-- Mantém o contrato do RPC da Etapa 10 e persiste o vínculo escolhido no painel.
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
      insert into public.service_people (service_id, profile_id, role, name, position)
      values (v_id, nullif(v_row->>'profile_id', '')::uuid, case when v_row->>'role' = 'musician' then 'musician' else 'singer' end, left(trim(v_row->>'name'), 120), coalesce((v_row->>'position')::integer, 0));
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
