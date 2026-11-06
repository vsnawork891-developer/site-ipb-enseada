const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
function send(res,status,body){res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.status(status).send(JSON.stringify(body));}
module.exports = async (req,res) => {
  if(req.method!=='POST') return send(res,405,{error:'Método não permitido.'});
  const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  const currentPassword=String(req.body?.currentPassword||'');
  const newPassword=String(req.body?.newPassword||'');
  if(!token) return send(res,401,{error:'Sessão não informada.'});
  if(!currentPassword) return send(res,400,{error:'Informe sua senha atual.'});
  if(newPassword.length<8) return send(res,400,{error:'A nova senha precisa ter pelo menos 8 caracteres.'});
  try{
    const auth=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:process.env.SUPABASE_PUBLISHABLE_KEY,Authorization:`Bearer ${token}`}});
    if(!auth.ok) return send(res,401,{error:'Sessão inválida.'});
    const user=await auth.json();
    const profileResponse=await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=id,must_change_password&id=eq.${encodeURIComponent(user.id)}&limit=1`,{headers:{apikey:SUPABASE_SECRET_KEY,Authorization:`Bearer ${SUPABASE_SECRET_KEY}`}});
    if(!profileResponse.ok) return send(res,500,{error:'Não foi possível validar o perfil.'});
    const profiles=await profileResponse.json();
    if(!profiles.length) return send(res,404,{error:'Perfil não encontrado.'});
    const passwordUpdate=await fetch(`${SUPABASE_URL}/auth/v1/user`,{method:'PUT',headers:{apikey:process.env.SUPABASE_PUBLISHABLE_KEY,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({current_password:currentPassword,password:newPassword})});
    if(!passwordUpdate.ok){const issue=await passwordUpdate.json().catch(()=>({}));return send(res,400,{error:issue.msg||issue.message||'Não foi possível alterar a senha.'});}
    const update=await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}`,{method:'PATCH',headers:{apikey:SUPABASE_SECRET_KEY,Authorization:`Bearer ${SUPABASE_SECRET_KEY}`,'Content-Type':'application/json',Prefer:'return=minimal'},body:JSON.stringify({must_change_password:false})});
    if(!update.ok) return send(res,500,{error:'A senha foi alterada, mas não foi possível atualizar o perfil. Entre novamente e procure o administrador.'});
    return send(res,200,{success:true});
  }catch{return send(res,500,{error:'Falha interna ao atualizar a senha.'});}
};
