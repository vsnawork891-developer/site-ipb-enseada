const crypto = require('node:crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const PANEL_BOOTSTRAP_SECRET = process.env.PANEL_BOOTSTRAP_SECRET;

function json(res, status, payload) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).send(JSON.stringify(payload));
}

function temporaryPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  const bytes = crypto.randomBytes(24);
  return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('');
}

async function supabase(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
  if (!response.ok) {
    const error = new Error(data?.msg || data?.message || data?.error_description || 'Falha na comunicação com o Supabase.');
    error.status = response.status;
    throw error;
  }
  return data;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'Método não permitido.' });
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY || !SUPABASE_SECRET_KEY || !PANEL_BOOTSTRAP_SECRET) {
    return json(res, 500, { error: 'Configuração do servidor incompleta.' });
  }

  const suppliedSecret = String(req.body?.bootstrapSecret || '');
  const expected = Buffer.from(PANEL_BOOTSTRAP_SECRET);
  const supplied = Buffer.from(suppliedSecret);
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
    return json(res, 403, { error: 'Código de inicialização inválido.' });
  }

  const fullName = 'Vinicius';
  const phone = '11986687029';
  const email = `${phone}@login.primeiraipbenseada.com.br`;
  let createdUserId = null;

  try {
    const existingOwners = await supabase('/rest/v1/profiles?select=id&is_owner=eq.true&limit=1');
    if (existingOwners.length) return json(res, 409, { error: 'A conta principal já foi criada. A inicialização não pode ser repetida.' });

    const groups = await supabase('/rest/v1/ministry_groups?select=id,name&is_active=eq.true');
    const requiredNames = ['Culto Público', 'Culto de Oração', 'EBD'];
    const missing = requiredNames.filter(name => !groups.some(group => group.name === name));
    if (missing.length) return json(res, 500, { error: `Grupos não encontrados no banco: ${missing.join(', ')}.` });

    const password = temporaryPassword();
    const authUser = await supabase('/auth/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: fullName, phone }
      })
    });
    createdUserId = authUser.id;

    await supabase('/rest/v1/profiles', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        id: createdUserId,
        full_name: fullName,
        phone,
        role: 'owner',
        is_owner: true,
        is_active: true,
        must_change_password: true
      })
    });

    await supabase('/rest/v1/group_memberships', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(groups.map(group => ({
        user_id: createdUserId,
        group_id: group.id,
        has_access: true,
        can_view: true,
        can_create: true,
        can_edit: true,
        can_delete: true
      })))
    });

    await supabase('/rest/v1/system_permissions', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        user_id: createdUserId,
        library_view: true,
        library_create: true,
        library_edit: true,
        library_delete: true,
        users_view: true,
        users_create: true,
        users_edit: true,
        users_delete: true,
        groups_view: true,
        groups_create: true,
        groups_edit: true,
        groups_delete: true,
        imports_create: true,
        audit_view: true
      })
    });

    return json(res, 201, {
      success: true,
      message: 'Conta principal criada. Guarde a senha temporária: ela será exibida somente nesta resposta.',
      loginPhone: phone,
      temporaryPassword: password
    });
  } catch (error) {
    if (createdUserId) {
      try { await supabase(`/auth/v1/admin/users/${createdUserId}`, { method: 'DELETE' }); } catch { /* rollback best-effort */ }
    }
    return json(res, error.status && error.status < 500 ? error.status : 500, {
      error: error.message || 'Não foi possível criar a conta principal.'
    });
  }
};
