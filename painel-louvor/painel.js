let SUPABASE_URL = '';
let SUPABASE_PUBLISHABLE_KEY = '';
const STORAGE_KEY = 'ipb_louvor_session';
const $ = id => document.getElementById(id);
const views = ['loginView', 'changePasswordView', 'homeView'];
let session = null;
let profile = null;
let items = [];
let snapshots = [];
let notes = [];
let dashboardInitialized = false;

function showView(id) {
  views.forEach(view => { $(view).hidden = view !== id; });
  $('feedback').textContent = '';
  $('feedback').className = 'feedback';
}
function message(text, success = false) {
  $('feedback').textContent = text;
  $('feedback').className = success ? 'feedback success' : 'feedback';
  if (text) window.setTimeout(() => { if ($('feedback').textContent === text) $('feedback').textContent = ''; }, 5000);
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function owner() { return profile?.is_owner === true || profile?.role === 'owner'; }
function permitted(key) { return owner() || profile?.permissions?.[key] === true; }
function canCreate() { return permitted('library_create'); }
function groupActionAllowed(item, action) {
  return (item.group_ids || []).every(id => profile?.groups?.some(group => group.id === id && group[`can_${action}`]));
}
function canEdit(item) { return owner() || permitted('library_edit') || (item.created_by === profile?.id && canCreate() && groupActionAllowed(item, 'edit')); }
function canDelete(item) { return owner() || permitted('library_delete') || (item.created_by === profile?.id && canCreate() && groupActionAllowed(item, 'delete')); }
function phoneEmail(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!/^\d{10,11}$/.test(digits)) throw new Error('Informe o telefone com DDD, usando 10 ou 11 números.');
  return `${digits}@login.primeiraipbenseada.com.br`;
}
async function parseResponse(response, fallback = 'O servidor retornou uma resposta inválida.') {
  const raw = await response.text();
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch {
    const detail = raw.replace(/\s+/g, ' ').trim().slice(0, 160);
    throw new Error(`${fallback} (HTTP ${response.status}). ${detail}`);
  }
}
async function supabase(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      'Content-Type': 'application/json',
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      ...(options.headers || {})
    }
  });
  const data = await parseResponse(response, 'O Supabase retornou uma resposta inválida.');
  if (!response.ok) throw new Error(data?.message || data?.msg || data?.error_description || data?.error || 'Não foi possível concluir a operação.');
  return data;
}
async function appApi(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}), ...(options.headers || {}) }
  });
  const data = await parseResponse(response, 'O servidor do painel retornou uma resposta inválida.');
  if (!response.ok) throw new Error(data?.error || 'Não foi possível concluir a operação.');
  return data;
}
function groupName(id) { return profile?.groups?.find(group => group.id === id)?.name || 'grupo com acesso restrito'; }
function visibilityLabel(item) {
  if (item.visibility === 'private') return 'Privado';
  if (item.visibility === 'groups') return (item.group_ids || []).map(groupName).filter((name, index, all) => all.indexOf(name) === index).join(', ') || 'Grupos';
  return 'Ministério';
}
function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}
function noteFor(itemId) { return notes.find(note => note.item_id === itemId)?.body || ''; }
function visibleItems() {
  const query = $('searchItems').value.trim().toLocaleLowerCase('pt-BR');
  const filter = $('filterVisibility').value;
  return items.filter(item => {
    const textMatch = !query || `${item.title} ${item.content}`.toLocaleLowerCase('pt-BR').includes(query);
    const filterMatch = filter === 'all' ||
      (filter === 'ministry' && item.visibility === 'ministry') ||
      (filter === 'groups' && item.visibility === 'groups') ||
      (filter === 'private' && item.created_by === profile.id);
    return textMatch && filterMatch;
  });
}
function renderItems() {
  const list = $('itemsList');
  const visible = visibleItems();
  list.replaceChildren();
  $('itemsCount').textContent = `${items.length} ${items.length === 1 ? 'item' : 'itens'}`;
  if (!permitted('library_view')) {
    list.hidden = true; $('emptyState').hidden = true; $('noAccessState').hidden = false; return;
  }
  list.hidden = false; $('noAccessState').hidden = true;
  $('emptyState').hidden = items.length > 0 || $('searchItems').value.trim().length > 0;
  if (!visible.length && items.length > 0) {
    list.innerHTML = '<div class="empty-state"><h3>Nenhum resultado</h3><p>Tente alterar a busca ou o filtro selecionado.</p></div>';
    return;
  }
  visible.forEach(item => {
    const itemSnapshots = snapshots.filter(snapshot => snapshot.item_id === item.id);
    const tagClass = item.visibility === 'groups' ? 'groups' : item.visibility === 'private' ? 'private' : '';
    const tag = item.visibility === 'groups' ? `Grupos · ${escapeHtml(visibilityLabel(item))}` : escapeHtml(visibilityLabel(item));
    const controls = `${canEdit(item) ? `<button class="button-outline" data-action="edit" data-id="${escapeHtml(item.id)}" type="button">Editar</button>` : ''}${canDelete(item) ? `<button class="button-quiet" data-action="delete" data-id="${escapeHtml(item.id)}" type="button">Excluir</button>` : ''}`;
    const snapshotMarkup = itemSnapshots.map(snapshot => `<li><strong>${escapeHtml(snapshot.title)}</strong><br><span>${escapeHtml(formatDate(snapshot.created_at))}</span><p>${escapeHtml(snapshot.content)}</p></li>`).join('') || '<li>Nenhuma versão anterior.</li>';
    const card = document.createElement('article');
    card.className = 'item-card';
    card.innerHTML = `<div class="item-card-top"><h3>${escapeHtml(item.title)}</h3><span class="visibility-tag ${tagClass}">${tag}</span></div><p class="item-content">${escapeHtml(item.content || 'Sem cifra ou observações adicionais.')}</p><small class="item-meta">Atualizado ${escapeHtml(formatDate(item.updated_at))}</small><div class="item-actions">${controls}</div><details class="item-note"><summary>Minha nota privada nesta música</summary><textarea data-note-for="${escapeHtml(item.id)}" maxlength="8000" rows="3" placeholder="Somente você pode ver esta nota">${escapeHtml(noteFor(item.id))}</textarea><button class="button-outline" data-action="save-note" data-id="${escapeHtml(item.id)}" type="button">Salvar nota</button></details><details class="snapshot-details"><summary>Histórico de versões (${itemSnapshots.length})</summary><ol class="snapshots-list">${snapshotMarkup}</ol></details>`;
    list.append(card);
  });
}
function renderGroups(selected = []) {
  const eligible = (profile?.groups || []).filter(group => group.can_create);
  $('groupChoices').innerHTML = eligible.map(group => `<label class="group-option"><input type="checkbox" name="itemGroup" value="${escapeHtml(group.id)}" ${selected.includes(group.id) ? 'checked' : ''}><span>${escapeHtml(group.name)}</span></label>`).join('') || '<span class="muted">Seu perfil não tem grupos com permissão de criação.</span>';
}
function openItem(item = null) {
  $('itemForm').reset();
  $('itemId').value = item?.id || '';
  $('itemTitle').value = item?.title || '';
  $('itemContent').value = item?.content || '';
  $('itemVisibility').value = item?.visibility || 'ministry';
  renderGroups(item?.group_ids || []);
  $('groupPicker').hidden = $('itemVisibility').value !== 'groups';
  $('itemFormTitle').textContent = item ? 'Editar repertório' : 'Novo repertório';
  $('itemFormWrap').hidden = false;
  $('itemFormWrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
async function loadData() {
  const tasks = [
    supabase(`/rest/v1/personal_notes?select=id,user_id,item_id,body,updated_at&user_id=eq.${encodeURIComponent(profile.id)}&order=updated_at.desc`)
  ];
  if (permitted('library_view')) {
    tasks.push(supabase('/rest/v1/library_items?select=id,title,content,visibility,group_ids,created_by,updated_by,created_at,updated_at&order=updated_at.desc'));
    tasks.push(supabase('/rest/v1/library_item_snapshots?select=id,item_id,title,content,visibility,group_ids,changed_by,created_at&order=created_at.desc'));
  }
  const results = await Promise.all(tasks);
  notes = results[0] || [];
  items = permitted('library_view') ? (results[1] || []) : [];
  snapshots = permitted('library_view') ? (results[2] || []) : [];
  $('personalNotes').value = notes.find(note => note.item_id === null)?.body || '';
  $('newItemButton').hidden = !canCreate();
  $('emptyNewItemButton').hidden = !canCreate();
  renderItems();
}
async function saveItem(event) {
  event.preventDefault();
  if (!canCreate() && !$('itemId').value) return message('Seu perfil não tem permissão para criar repertórios.');
  const id = $('itemId').value;
  const visibility = $('itemVisibility').value;
  const groupIds = visibility === 'groups' ? [...document.querySelectorAll('input[name="itemGroup"]:checked')].map(input => input.value) : [];
  if (visibility === 'groups' && !groupIds.length) return message('Selecione ao menos um grupo para compartilhar.');
  const button = $('itemForm').querySelector('button[type="submit"]');
  button.disabled = true;
  const body = { title: $('itemTitle').value.trim(), content: $('itemContent').value.trim(), visibility, group_ids: groupIds };
  try {
    if (id) {
      const updated = await supabase(`/rest/v1/library_items?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(body) });
      if (!updated?.length) throw new Error('Nenhuma alteração foi salva. Confira sua permissão para editar este repertório.');
    } else {
      body.created_by = profile.id; body.updated_by = profile.id;
      const created = await supabase('/rest/v1/library_items', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(body) });
      if (!created?.length) throw new Error('O repertório não foi criado. Confira sua permissão de criação.');
    }
    $('itemFormWrap').hidden = true;
    await loadData();
    message(id ? 'Repertório atualizado e versão anterior arquivada.' : 'Repertório salvo no banco de dados.', true);
  } catch (error) { message(error.message); }
  finally { button.disabled = false; }
}
async function saveNote(itemId, body) {
  const existing = notes.find(note => note.item_id === itemId);
  if (existing) {
    const updated = await supabase(`/rest/v1/personal_notes?id=eq.${encodeURIComponent(existing.id)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ body }) });
    if (!updated?.length) throw new Error('A nota não foi atualizada. Recarregue a página e tente novamente.');
  } else {
    const created = await supabase('/rest/v1/personal_notes', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ user_id: profile.id, item_id: itemId, body }) });
    if (!created?.length) throw new Error('A nota não foi salva. Confira se você ainda tem acesso ao repertório.');
  }
  notes = await supabase(`/rest/v1/personal_notes?select=id,user_id,item_id,body,updated_at&user_id=eq.${encodeURIComponent(profile.id)}&order=updated_at.desc`);
}
async function handleItemAction(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const id = button.dataset.id;
  const action = button.dataset.action;
  const item = items.find(row => row.id === id);
  if (action === 'edit' && item) return openItem(item);
  button.disabled = true;
  try {
    if (action === 'delete') {
      if (!window.confirm('Excluir este repertório e seu histórico de versões?')) return;
      const deleted = await supabase(`/rest/v1/library_items?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
      if (!deleted?.length) throw new Error('Nenhuma exclusão foi feita. Confira sua permissão para excluir este repertório.');
      await loadData();
      return message('Repertório excluído.', true);
    }
    if (action === 'save-note') {
      const textarea = document.querySelector(`textarea[data-note-for="${CSS.escape(id)}"]`);
      await saveNote(id, textarea.value);
      renderItems();
      return message('Nota pessoal salva no banco.', true);
    }
  } catch (error) { message(error.message); }
  finally { button.disabled = false; }
}
async function saveGeneralNotes() {
  const button = $('saveNotesButton'); button.disabled = true;
  try {
    await saveNote(null, $('personalNotes').value);
    message('Notas pessoais salvas no banco.', true);
  } catch (error) { message(error.message); }
  finally { button.disabled = false; }
}
function setupDashboard() {
  if (dashboardInitialized) return;
  dashboardInitialized = true;
  $('itemVisibility').addEventListener('change', () => {
    $('groupPicker').hidden = $('itemVisibility').value !== 'groups';
    if (!$('groupPicker').hidden) renderGroups();
  });
  $('newItemButton').addEventListener('click', () => openItem());
  $('emptyNewItemButton').addEventListener('click', () => openItem());
  $('cancelItemButton').addEventListener('click', () => { $('itemFormWrap').hidden = true; });
  $('cancelItemButtonBottom').addEventListener('click', () => { $('itemFormWrap').hidden = true; });
  $('itemForm').addEventListener('submit', saveItem);
  $('itemsList').addEventListener('click', handleItemAction);
  $('searchItems').addEventListener('input', renderItems);
  $('filterVisibility').addEventListener('change', renderItems);
  $('saveNotesButton').addEventListener('click', saveGeneralNotes);
}
async function loadProfile() {
  const user = await supabase('/auth/v1/user');
  const data = await appApi('/api/me');
  profile = data.profile;
  if (!profile || !profile.is_active) throw new Error('Este acesso está inativo. Procure o administrador.');
  if (profile.must_change_password) return showView('changePasswordView');
  $('welcomeTitle').textContent = `Olá, ${profile.full_name || user.user_metadata?.full_name || 'bem-vindo(a)'}`;
  showView('homeView');
  setupDashboard();
  await loadData();
}

$('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter; button.disabled = true;
  try {
    const email = phoneEmail($('phone').value);
    const data = await supabase('/auth/v1/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email, password: $('password').value }) });
    session = data; localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    await loadProfile();
  } catch (error) {
    session = null; localStorage.removeItem(STORAGE_KEY); message(error.message);
  } finally { button.disabled = false; }
});

$('changePasswordForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  const currentPassword = $('currentPassword').value;
  const newPassword = $('newPassword').value;
  if (newPassword !== $('confirmPassword').value) return message('As senhas não coincidem.');
  if (newPassword.length < 8) return message('A senha precisa ter pelo menos 8 caracteres.');
  button.disabled = true;
  try {
    await appApi('/api/password-changed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword, newPassword }) });
    profile.must_change_password = false;
    $('currentPassword').value = ''; $('newPassword').value = ''; $('confirmPassword').value = '';
    $('welcomeTitle').textContent = `Olá, ${profile.full_name || 'bem-vindo(a)'}`;
    showView('homeView'); setupDashboard(); await loadData();
  } catch (error) { message(error.message); }
  finally { button.disabled = false; }
});

$('logoutButton').addEventListener('click', async () => {
  try { if (session?.access_token) await supabase('/auth/v1/logout', { method: 'POST' }); } catch { /* limpa a sessão local mesmo sem rede */ }
  session = null; profile = null; localStorage.removeItem(STORAGE_KEY); $('password').value = ''; showView('loginView');
});

(async function initializePanel() {
  try {
    const response = await fetch('/api/config', { cache: 'no-store' });
    const config = await parseResponse(response, 'A configuração pública do painel não respondeu em JSON.');
    if (!response.ok) throw new Error(config?.error || `Falha ao carregar a configuração (HTTP ${response.status}).`);
    if (!config?.supabaseUrl || !config?.publishableKey) throw new Error('A configuração pública do painel está incompleta.');
    SUPABASE_URL = config.supabaseUrl; SUPABASE_PUBLISHABLE_KEY = config.publishableKey;
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return;
    session = JSON.parse(saved);
    await loadProfile();
  } catch (error) {
    session = null; localStorage.removeItem(STORAGE_KEY); showView('loginView'); message(error.message || 'Não foi possível iniciar o painel.');
  }
})();
