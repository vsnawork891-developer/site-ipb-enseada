-- Etapa 9: administração de usuários e permissões por grupo.
-- Execute no Supabase SQL Editor antes de publicar os novos arquivos.

alter table public.profiles
  add column if not exists all_groups_access boolean not null default false;

grant select, insert, update on table public.profiles to service_role;
grant select, insert, update, delete on table public.group_memberships to service_role;
grant select, insert, update on table public.system_permissions to service_role;
grant select on table public.ministry_groups to service_role;

-- A permissão global de visualização também cobre grupos criados futuramente.
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
        or (p_action_key = 'view' and exists (
          select 1 from public.profiles p
          where p.id = auth.uid() and p.all_groups_access is true
        ))
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

revoke all on function public.panel_current_group_can(uuid, text) from public, anon;
grant execute on function public.panel_current_group_can(uuid, text) to authenticated;
