const crypto = require('node:crypto');

const URL = process.env.SUPABASE_URL;
const PUBLIC_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const PERMISSIONS = ['library_view','library_create','library_edit','library_delete','users_view','users_create','users_edit','users_delete','groups_view','groups_create','groups_edit','groups_delete','imports_create','audit_view'];

function send(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  return res.status(status).json(body);
}
async function rest(path, method = 'GET', body, prefer = 'return=representation') {
  const response = await fetch(`${URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}`, 'Content-Type': 'application/json', Prefer: prefer },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.message || data?.msg || 'Falha ao consultar o banco.');
  return data;
}
async function authAdmin(path, method, body) {
  const response = await fetch(`${URL}/auth/v1/admin${path}`, {
    method,
    headers: { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.msg || data?.message || 'A operação de autenticação falhou.');
  return data;
}
async function requireActor(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) throw Object.assign(new Error('Sessão não informada.'), { status: 401 });
  const auth = await fetch(`${URL}/auth/v1/user`, { headers: { apikey: PUBLIC_KEY, Authorization: `Bearer ${token}` } });
  if (!auth.ok) throw Object.assign(new Error('Sessão inválida ou expirada.'), { status: 401 });
  const user = await auth.json();
  const rows = await rest(`profiles?select=id,is_owner,role,is_active&id=eq.${encodeURIComponent(user.id)}&limit=1`);
  if (!rows[0]?.is_active) throw Object.assign(new Error('Acesso inativo.'), { status: 403 });
  const owner = rows[0].is_owner === true || rows[0].role === 'owner';
  const perms = await rest(`system_permissions?select=${PERMISSIONS.join(',')}&user_id=eq.${encodeURIComponent(user.id)}&limit=1`);
  return { id: user.id, owner, permissions: perms[0] || {} };
}
function allowed(actor, action) {
  if (actor.owner) return true;
  if (action === 'list') return ['users_view','users_create','users_edit','users_delete'].some(key => actor.permissions[key] === true);
  const key = { list: 'users_view', create: 'users_create', edit: 'users_edit', deactivate: 'users_delete', reset: 'users_edit' }[action];
  return actor.permissions[key] === true;
}
function tempPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  const chars = Array.from(crypto.randomBytes(24), byte => alphabet[byte % alphabet.length]);
  return chars.join('');
}
function normalizePhone(value) {
  const phone = String(value || '').replace(/\D/g, '');
  if (!/^\d{10,11}$/.test(phone)) throw Object.assign(new Error('Informe telefone com DDD, usando 10 ou 11 números.'), { status: 400 });
  return phone;
}
function bool(value) { return value === true; }
function validatePermissions(input = {}) {
  return Object.fromEntries(PERMISSIONS.map(key => [key, bool(input[key])]));
}
function safeNonOwnerPermissions(input = {}) {
  const permissions = validatePermissions(input);
  return Object.fromEntries(PERMISSIONS.map(key => [key, key === 'library_view' && permissions[key]]));
}
async function ensureAssignableGroups(actor, groupIds, allGroups) {
  const unique = [...new Set((Array.isArray(groupIds) ? groupIds : []).map(String))];
  const validGroups = unique.length ? await rest(`ministry_groups?select=id&id=in.(${unique.map(encodeURIComponent).join(',')})&is_active=eq.true`) : [];
  if (validGroups.length !== unique.length) throw Object.assign(new Error('Um ou mais grupos selecionados não estão disponíveis.'), { status: 400 });
  if (allGroups && !actor.owner) throw Object.assign(new Error('Somente o administrador geral pode conceder acesso a todos os grupos.'), { status: 403 });
  if (!actor.owner && unique.length) {
    const managed = await rest(`group_memberships?select=group_id&user_id=eq.${encodeURIComponent(actor.id)}&has_access=eq.true&can_edit=eq.true`);
    const allowedIds = new Set(managed.map(row => row.group_id));
    if (unique.some(id => !allowedIds.has(id))) throw Object.assign(new Error('Você só pode atribuir pessoas aos grupos que administra.'), { status: 403 });
  }
  return unique;
}
function groupRows(input, legacyGroups, userId, isOwner) {
  const rows = Array.isArray(input) ? input : (Array.isArray(legacyGroups) ? legacyGroups.map(group_id => ({ group_id, can_view: true })) : []);
  return rows.map(row => ({
    user_id: userId,
    group_id: String(row.group_id),
    has_access: row.can_view === true || row.can_create === true || row.can_edit === true || row.can_delete === true,
    can_view: row.can_view === true,
    can_create: isOwner && row.can_create === true,
    can_edit: isOwner && row.can_edit === true,
    can_delete: isOwner && row.can_delete === true
  })).filter(row => row.has_access);
}

module.exports = async (req, res) => {
  if (!URL || !PUBLIC_KEY || !SECRET_KEY) return send(res, 500, { error: 'Configuração do servidor incompleta.' });
  try {
    const actor = await requireActor(req);
    if (req.method === 'GET') {
      if (!allowed(actor, 'list')) return send(res, 403, { error: 'Você não tem permissão para consultar usuários.' });
      const [profiles, permissionRows, memberships, groups] = await Promise.all([
        rest('profiles?select=id,full_name,phone,role,is_owner,is_active,must_change_password,all_groups_access&order=full_name.asc'),
        rest(`system_permissions?select=user_id,${PERMISSIONS.join(',')}`),
        rest('group_memberships?select=user_id,group_id,has_access,can_view,can_create,can_edit,can_delete'),
        rest('ministry_groups?select=id,name,is_active&order=name.asc')
      ]);
      const result = profiles.map(profile => ({
        ...profile,
        permissions: permissionRows.find(row => row.user_id === profile.id) || {},
        groups: memberships.filter(row => row.user_id === profile.id && row.has_access).map(row => row.group_id),
        groupPermissions: memberships.filter(row => row.user_id === profile.id && row.has_access)
      }));
      return send(res, 200, { users: result, groups });
    }
    if (!['POST', 'PATCH'].includes(req.method)) { res.setHeader('Allow', 'GET, POST, PATCH'); return send(res, 405, { error: 'Método não permitido.' }); }
    const body = req.body || {};
    if (body.action === 'reset_password') {
      if (!allowed(actor, 'reset')) return send(res, 403, { error: 'Você não tem permissão para redefinir senhas.' });
      const target = String(body.user_id || '');
      const rows = await rest(`profiles?select=id,is_owner,role,is_active&id=eq.${encodeURIComponent(target)}&limit=1`);
      if (!rows[0]) return send(res, 404, { error: 'Usuário não encontrado.' });
      if ((rows[0].is_owner || rows[0].role === 'owner') && !actor.owner) return send(res, 403, { error: 'Somente o administrador geral pode redefinir a conta principal.' });
      const password = tempPassword();
      await authAdmin(`/users/${encodeURIComponent(target)}`, 'PUT', { password });
      await rest(`profiles?id=eq.${encodeURIComponent(target)}`, 'PATCH', { must_change_password: true });
      return send(res, 200, { success: true, temporaryPassword: password });
    }
    if (req.method === 'POST') {
      if (!allowed(actor, 'create')) return send(res, 403, { error: 'Você não tem permissão para criar usuários.' });
      const fullName = String(body.full_name || '').trim().slice(0, 120);
      if (!fullName) return send(res, 400, { error: 'Informe o nome do usuário.' });
      const phone = normalizePhone(body.phone);
      const email = `${phone}@login.primeiraipbenseada.com.br`;
      const duplicate = await rest(`profiles?select=id&phone=eq.${encodeURIComponent(phone)}&limit=1`);
      if (duplicate.length) return send(res, 409, { error: 'Já existe um usuário cadastrado com este telefone.' });
      const requestedGroupRows = Array.isArray(body.group_permissions) ? body.group_permissions : (body.groups || []).map(group_id => ({ group_id, can_view: true }));
      const selectedGroups = await ensureAssignableGroups(actor, requestedGroupRows.map(row => row.group_id), body.all_groups_access === true);
      if (!actor.owner && body.role === 'admin') return send(res, 403, { error: 'Somente o administrador geral pode criar administradores.' });
      const password = tempPassword();
      let userId = null;
      try {
        const authUser = await authAdmin('/users', 'POST', { email, password, email_confirm: true, user_metadata: { full_name: fullName, phone } });
        userId = authUser.id;
        const role = ['member', 'admin'].includes(body.role) ? body.role : 'member';
        await rest('profiles', 'POST', { id: userId, full_name: fullName, phone, role, is_owner: false, is_active: true, must_change_password: true, all_groups_access: bool(body.all_groups_access) });
        const memberships = groupRows(requestedGroupRows, selectedGroups, userId, actor.owner);
        if (memberships.length) await rest('group_memberships', 'POST', memberships);
        await rest('system_permissions', 'POST', { user_id: userId, ...(actor.owner ? validatePermissions(body.permissions) : safeNonOwnerPermissions(body.permissions)) });
        return send(res, 201, { success: true, user: { id: userId, full_name: fullName, phone }, temporaryPassword: password });
      } catch (error) {
        if (userId) { try { await authAdmin(`/users/${encodeURIComponent(userId)}`, 'DELETE'); } catch { /* best-effort rollback */ } }
        throw error;
      }
    }
    if (!allowed(actor, 'edit') && !allowed(actor, 'deactivate')) return send(res, 403, { error: 'Você não tem permissão para editar usuários.' });
    const target = String(body.id || '');
    const existing = await rest(`profiles?select=id,is_owner,role,all_groups_access&id=eq.${encodeURIComponent(target)}&limit=1`);
    if (!existing[0]) return send(res, 404, { error: 'Usuário não encontrado.' });
    const protectedOwner = existing[0].is_owner || existing[0].role === 'owner';
    if (protectedOwner && (!actor.owner || target === actor.id)) return send(res, 403, { error: 'A conta do administrador geral não pode ser alterada por esta tela.' });
    if (target === actor.id && !actor.owner) return send(res, 403, { error: 'Você não pode alterar seu próprio cadastro por esta tela.' });
    if (body.is_active === false && !allowed(actor, 'deactivate')) return send(res, 403, { error: 'Você não tem permissão para desativar usuários.' });
    if (!allowed(actor, 'edit') && body.is_active !== false) return send(res, 403, { error: 'Você não tem permissão para editar usuários.' });
    if (!allowed(actor, 'edit')) {
      await rest(`profiles?id=eq.${encodeURIComponent(target)}`, 'PATCH', { is_active: false });
      return send(res, 200, { success: true });
    }
    const fullName = String(body.full_name || '').trim().slice(0, 120);
    const phone = normalizePhone(body.phone);
    if (!fullName) return send(res, 400, { error: 'Informe o nome do usuário.' });
    const collision = await rest(`profiles?select=id&phone=eq.${encodeURIComponent(phone)}&id=neq.${encodeURIComponent(target)}&limit=1`);
    if (collision.length) return send(res, 409, { error: 'Outro usuário já utiliza este telefone.' });
    if (!actor.owner && body.role === 'admin') return send(res, 403, { error: 'Somente o administrador geral pode atribuir o perfil administrador.' });
    const role = actor.owner ? (['member', 'admin'].includes(body.role) ? body.role : 'member') : existing[0].role;
    const requestedGroupRows = Array.isArray(body.group_permissions) ? body.group_permissions : (body.groups || []).map(group_id => ({ group_id, can_view: true }));
    const selectedGroups = actor.owner ? await ensureAssignableGroups(actor, requestedGroupRows.map(row => row.group_id), body.all_groups_access === true) : [];
    await authAdmin(`/users/${encodeURIComponent(target)}`, 'PUT', { email: `${phone}@login.primeiraipbenseada.com.br`, email_confirm: true, user_metadata: { full_name: fullName, phone } });
    await rest(`profiles?id=eq.${encodeURIComponent(target)}`, 'PATCH', { full_name: fullName, phone, role, is_active: body.is_active !== false, all_groups_access: actor.owner ? bool(body.all_groups_access) : existing[0].all_groups_access === true });
    if (actor.owner) {
      await rest(`group_memberships?user_id=eq.${encodeURIComponent(target)}`, 'DELETE', undefined, 'return=minimal');
      const memberships = groupRows(requestedGroupRows, selectedGroups, target, true);
      if (memberships.length) await rest('group_memberships', 'POST', memberships);
      const permissions = validatePermissions(body.permissions);
      const oldPermissions = await rest(`system_permissions?select=user_id&user_id=eq.${encodeURIComponent(target)}&limit=1`);
      if (oldPermissions.length) await rest(`system_permissions?user_id=eq.${encodeURIComponent(target)}`, 'PATCH', permissions);
      else await rest('system_permissions', 'POST', { user_id: target, ...permissions });
    }
    return send(res, 200, { success: true });
  } catch (error) {
    return send(res, error.status || 500, { error: error.message || 'Não foi possível concluir a operação.' });
  }
};
