let SUPABASE_URL = '';
let SUPABASE_PUBLISHABLE_KEY = '';
const STORAGE_KEY = 'ipb_louvor_session';
const DEMO_DATA_KEY = 'ipb_louvor_stage7_demo';

const $ = (id) => document.getElementById(id);
const views = ['loginView', 'changePasswordView', 'homeView'];
let session = null;
let profile = null;
let stage7Initialized = false;

function showView(id) {
  views.forEach(view => { $(view).hidden = view !== id; });
  $('feedback').textContent = '';
  $('feedback').className = 'feedback';
}
function message(text, success = false) {
  $('feedback').textContent = text;
  $('feedback').className = success ? 'feedback success' : 'feedback';
}
function demoData() {
  try { return JSON.parse(localStorage.getItem(DEMO_DATA_KEY)) || { items: [], groups: {}, notes: {} }; }
  catch { return { items: [], groups: {}, notes: {} }; }
}
function saveDemoData(data) { localStorage.setItem(DEMO_DATA_KEY, JSON.stringify(data)); }
function userKey() { return String(profile?.id || 'unknown'); }
function isOwner() { return profile?.is_owner === true || profile?.role === 'owner'; }
function userGroups(data = demoData()) { return data.groups[userKey()] || []; }
function canSee(item, data = demoData()) {
  return isOwner() || item.authorId === userKey() || item.visibility === 'ministry' ||
    (item.visibility === 'groups' && item.groups.some(group => userGroups(data).includes(group)));
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char])); }
function renderItems() {
  const data = demoData();
  const list = $('itemsList');
  const visible = data.items.filter(item => canSee(item, data)).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
  list.replaceChildren();
  if (!visible.length) { list.innerHTML = '<p class="muted">Nenhum item visível neste protótipo.</p>'; return; }
  visible.forEach(item => {
    const card = document.createElement('article'); card.className = 'item-card';
    const snapshots = (item.snapshots || []).map((snapshot, index) => `<li>Snapshot ${item.snapshots.length-index}: ${escapeHtml(new Date(snapshot.at).toLocaleString('pt-BR'))} — ${escapeHtml(snapshot.title)}</li>`).join('');
    const mine = item.authorId === userKey();
    card.innerHTML = `<h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.content || 'Sem conteúdo')}</p><small>Visibilidade: ${escapeHtml(item.visibility === 'private' ? 'privado' : item.visibility === 'groups' ? `grupos: ${item.groups.join(', ')}` : 'ministério')} · atualizado ${escapeHtml(new Date(item.updatedAt).toLocaleString('pt-BR'))}</small><label>Nota pessoal neste item</label><textarea data-note="${escapeHtml(item.id)}" rows="2" maxlength="2000" placeholder="Sua nota privada">${escapeHtml((data.notes[userKey()] || {})[item.id] || '')}</textarea><button data-save-note="${escapeHtml(item.id)}" type="button">Salvar nota</button>${mine || isOwner() ? `<button data-edit="${escapeHtml(item.id)}" type="button">Editar</button><button data-delete="${escapeHtml(item.id)}" class="secondary" type="button">Excluir</button>` : ''}<details><summary>Snapshots (${(item.snapshots || []).length})</summary><ol>${snapshots || '<li>Nenhum snapshot anterior</li>'}</ol></details>`;
    list.append(card);
  });
}
function openItem(item = null) {
  $('itemForm').reset(); $('itemId').value = item?.id || ''; $('itemTitle').value = item?.title || ''; $('itemContent').value = item?.content || '';
  $('itemVisibility').value = item?.visibility || 'ministry'; $('itemGroups').value = (item?.groups || []).join(', '); $('groupPicker').hidden = $('itemVisibility').value !== 'groups'; $('itemFormWrap').hidden = false;
}
function setupStage7() {
  if (stage7Initialized) { renderItems(); const current = demoData(); $('myGroups').value = userGroups(current).join(', '); $('personalNotes').value = (current.notes[userKey()] || {}).__general || ''; return; }
  stage7Initialized = true;
  $('itemVisibility').addEventListener('change', () => { $('groupPicker').hidden = $('itemVisibility').value !== 'groups'; });
  $('newItemButton').addEventListener('click', () => openItem());
  $('cancelItemButton').addEventListener('click', () => { $('itemFormWrap').hidden = true; });
  $('itemForm').addEventListener('submit', event => {
    event.preventDefault(); const data = demoData(); const id = $('itemId').value; const prior = data.items.find(item => item.id === id);
    if (prior && prior.authorId !== userKey() && !isOwner()) return message('Você não pode editar este item.');
    const title = $('itemTitle').value.trim(); if (!title) return message('Informe um título.');
    const now = new Date().toISOString();
    const item = { id: id || crypto.randomUUID(), title, content: $('itemContent').value.trim(), visibility: $('itemVisibility').value, groups: $('itemVisibility').value === 'groups' ? [...new Set($('itemGroups').value.split(',').map(x => x.trim()).filter(Boolean))] : [], authorId: prior?.authorId || userKey(), updatedAt: now, snapshots: prior?.snapshots || [] };
    if (item.visibility === 'groups' && !item.groups.length) return message('Informe ao menos um grupo.');
    if (prior) { item.snapshots.push({ title: prior.title, content: prior.content, visibility: prior.visibility, groups: prior.groups, at: prior.updatedAt }); data.items[data.items.indexOf(prior)] = item; }
    else data.items.push(item);
    saveDemoData(data); $('itemFormWrap').hidden = true; renderItems(); message('Item salvo neste navegador.', true);
  });
  $('itemsList').addEventListener('click', event => {
    const id = event.target.dataset.edit || event.target.dataset.delete || event.target.dataset.saveNote;
    if (!id) return; const data = demoData(); const item = data.items.find(row => row.id === id);
    if (event.target.dataset.edit) return openItem(item);
    if (event.target.dataset.delete) { if (!item || (item.authorId !== userKey() && !isOwner())) return message('Você não pode excluir este item.'); data.items = data.items.filter(row => row.id !== id); saveDemoData(data); renderItems(); return message('Item removido deste navegador.', true); }
    if (event.target.dataset.saveNote) { data.notes[userKey()] ||= {}; data.notes[userKey()][id] = $('textarea[data-note="'+CSS.escape(id)+'"]').value; saveDemoData(data); return message('Nota pessoal salva neste navegador.', true); }
  });
  $('saveNotesButton').addEventListener('click', () => { const data = demoData(); data.notes[userKey()] ||= {}; data.notes[userKey()].__general = $('personalNotes').value; saveDemoData(data); message('Notas pessoais salvas neste navegador.', true); });
  $('saveGroupsButton').addEventListener('click', () => { const data = demoData(); data.groups[userKey()] = [...new Set($('myGroups').value.split(',').map(x => x.trim()).filter(Boolean))]; saveDemoData(data); renderItems(); message('Grupos de demonstração salvos neste navegador.', true); });
  renderItems(); const data = demoData(); $('myGroups').value = userGroups(data).join(', '); $('personalNotes').value = (data.notes[userKey()] || {}).__general || '';
}
function phoneEmail(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!/^\d{10,11}$/.test(digits)) throw new Error('Informe o telefone com DDD, usando 10 ou 11 números.');
  return `${digits}@login.primeiraipbenseada.com.br`;
}
async function readJson(response, fallbackMessage = 'O servidor retornou uma resposta inválida.') {
  const raw = await response.text();
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch {
    const detail = raw.replace(/\s+/g, ' ').trim().slice(0, 180);
    throw new Error(`${fallbackMessage} (HTTP ${response.status}). ${detail}`);
  }
}

async function api(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      'Content-Type': 'application/json',
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      ...(options.headers || {})
    }
  });
  const data = await readJson(response, 'O Supabase retornou uma resposta inválida.');
  if (!response.ok) throw new Error(data.msg || data.message || data.error_description || data.error || 'Não foi possível concluir a operação.');
  return data;
}
async function loadProfile() {
  const user = await api('/auth/v1/user');
  const response = await fetch('/api/me', {
    headers: { Authorization: `Bearer ${session.access_token}` }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Não foi possível carregar seu perfil.');
  profile = data.profile;
  if (!profile || !profile.is_active) throw new Error('Este acesso está inativo. Procure o administrador.');
  if (profile.must_change_password) return showView('changePasswordView');
  $('welcomeTitle').textContent = `Olá, ${profile.full_name || user.user_metadata?.full_name || 'bem-vindo(a)'}`;
  showView('homeView');
  setupStage7();
}

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const email = phoneEmail($('phone').value);
    const data = await api('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: JSON.stringify({ email, password: $('password').value })
    });
    session = data;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    await loadProfile();
  } catch (error) {
    session = null;
    localStorage.removeItem(STORAGE_KEY);
    message(error.message);
  } finally { button.disabled = false; }
});

$('changePasswordForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  const password = $('newPassword').value;
  if (password !== $('confirmPassword').value) return message('As senhas não coincidem.');
  if (password.length < 8) return message('A senha precisa ter pelo menos 8 caracteres.');
  button.disabled = true;
  try {
    const response = await fetch('/api/password-changed', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ newPassword: password }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'A senha foi alterada, mas não foi possível atualizar o perfil. Entre novamente e contate o administrador.');
    profile.must_change_password = false;
    $('welcomeTitle').textContent = `Olá, ${profile.full_name || 'bem-vindo(a)'}`;
    showView('homeView');
  } catch (error) { message(error.message); }
  finally { button.disabled = false; }
});

$('logoutButton').addEventListener('click', async () => {
  try { if (session?.access_token) await api('/auth/v1/logout', { method: 'POST' }); } catch { /* encerra localmente mesmo se a rede falhar */ }
  session = null; profile = null; localStorage.removeItem(STORAGE_KEY); $('password').value = ''; showView('loginView');
});

(async function initializePanel() {
  try {
    const configResponse = await fetch('/api/config', { cache: 'no-store' });
    const config = await readJson(configResponse, 'A função /api/config não respondeu em JSON.');
    if (!configResponse.ok) throw new Error(config.error || `Falha ao carregar a configuração (HTTP ${configResponse.status}).`);
    if (!config.supabaseUrl || !config.publishableKey) throw new Error('A configuração pública está incompleta. Confira SUPABASE_URL e SUPABASE_PUBLISHABLE_KEY no ambiente Preview da Vercel.');
    SUPABASE_URL = config.supabaseUrl;
    SUPABASE_PUBLISHABLE_KEY = config.publishableKey;
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return;
    session = JSON.parse(saved);
    await loadProfile();
  } catch (error) {
    session = null; localStorage.removeItem(STORAGE_KEY); showView('loginView'); message(error.message || 'Não foi possível iniciar o painel.');
  }
})();
