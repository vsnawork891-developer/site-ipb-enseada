const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
function send(res, status, body) { res.setHeader('Content-Type','application/json; charset=utf-8'); res.setHeader('Cache-Control','no-store'); res.status(status).send(JSON.stringify(body)); }
module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res,405,{error:'Método não permitido.'});
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i,'');
  if (!token) return send(res,401,{error:'Sessão não informada.'});
  try {
    const auth = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers:{ apikey:process.env.SUPABASE_PUBLISHABLE_KEY, Authorization:`Bearer ${token}` } });
    if (!auth.ok) return send(res,401,{error:'Sessão inválida ou expirada.'});
    const user = await auth.json();
    const result = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=id,full_name,phone,role,is_owner,is_active,must_change_password&id=eq.${encodeURIComponent(user.id)}&limit=1`, { headers:{ apikey:SUPABASE_SECRET_KEY, Authorization:`Bearer ${SUPABASE_SECRET_KEY}` } });
    if (!result.ok) return send(res,500,{error:'Não foi possível consultar o perfil.'});
    const rows = await result.json();
    if (!rows.length) return send(res,404,{error:'Perfil não encontrado.'});
    if (!rows[0].is_active) return send(res,403,{error:'Acesso inativo.'});
    return send(res,200,{profile:rows[0]});
  } catch { return send(res,500,{error:'Falha interna ao consultar o perfil.'}); }
};
