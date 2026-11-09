const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

function send(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  return res.status(status).json(body);
}

async function rest(path) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_SECRET_KEY, Authorization: `Bearer ${SUPABASE_SECRET_KEY}` }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || 'Consulta de permissões recusada.');
  return data;
}

const PERMISSION_KEYS = [
  'library_view', 'library_create', 'library_edit', 'library_delete',
  'users_view', 'users_create', 'users_edit', 'users_delete',
  'groups_view', 'groups_create', 'groups_edit', 'groups_delete',
  'imports_create', 'audit_view'
];

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return send(res, 405, { error: 'Método não permitido.' });
  }
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) return send(res, 500, { error: 'Configuração do servidor incompleta.' });

  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return send(res, 401, { error: 'Sessão não informada.' });

  try {
    const auth = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` }
    });
    if (!auth.ok) return send(res, 401, { error: 'Sessão inválida ou expirada.' });
    const user = await auth.json();
    const id = encodeURIComponent(user.id);

    const [profiles, permissionRows, memberships, activeGroups] = await Promise.all([
      rest(`profiles?select=id,full_name,phone,role,is_owner,is_active,must_change_password,all_groups_access&id=eq.${id}&limit=1`),
      rest(`system_permissions?select=${PERMISSION_KEYS.join(',')}&user_id=eq.${id}&limit=1`),
      rest(`group_memberships?select=group_id,has_access,can_view,can_create,can_edit,can_delete&user_id=eq.${id}&has_access=eq.true`),
      rest('ministry_groups?select=id,name,is_active&is_active=eq.true&order=name.asc')
    ]);

    if (!profiles.length) return send(res, 404, { error: 'Perfil não encontrado.' });
    const profile = profiles[0];
    if (!profile.is_active) return send(res, 403, { error: 'Acesso inativo.' });
    const owner = profile.is_owner === true || profile.role === 'owner';
    const permissionRow = permissionRows[0] || {};
    const groupAccess = new Map(memberships.map(row => [row.group_id, row]));
    const groups = activeGroups
      .filter(group => owner || profile.all_groups_access === true || groupAccess.has(group.id))
      .map(group => {
        const access = groupAccess.get(group.id) || {};
        const globalView = profile.all_groups_access === true;
        return {
          id: group.id,
          name: group.name,
          can_view: owner || globalView || access.can_view === true,
          can_create: owner || access.can_create === true,
          can_edit: owner || access.can_edit === true,
          can_delete: owner || access.can_delete === true
        };
      });

    return send(res, 200, {
      profile: {
        ...profile,
        permissions: Object.fromEntries(PERMISSION_KEYS.map(key => [key, owner || permissionRow[key] === true])),
        groups
      }
    });
  } catch {
    return send(res, 500, { error: 'Não foi possível carregar perfil, permissões e grupos.' });
  }
};
