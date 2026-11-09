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
let managedUsers = [];
let managedGroups = [];
let ministryGroups = [];
let songCatalog = [];
let selectedGroup = null;
let importDraft = [];
let returnToServiceEditor = false;
let returnToServiceRow = null;
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
function safeExternalUrl(value) {
  try { const url = new URL(String(value || '')); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; }
  catch { return ''; }
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
const permissionLabels = {
  library_view: 'Consultar biblioteca', library_create: 'Criar repertórios', library_edit: 'Editar repertórios', library_delete: 'Excluir repertórios',
  users_view: 'Consultar usuários', users_create: 'Criar usuários', users_edit: 'Editar usuários e redefinir senhas', users_delete: 'Desativar usuários',
  groups_view: 'Consultar grupos', groups_create: 'Criar grupos', groups_edit: 'Editar grupos', groups_delete: 'Desativar grupos',
  imports_create: 'Importar dados', audit_view: 'Consultar auditoria'
};
const groupPermissionLabels = { can_view: 'Ver', can_create: 'Criar', can_edit: 'Editar', can_delete: 'Excluir' };
function canManageUsers(action) { return owner() || profile?.permissions?.[`users_${action}`] === true; }
function canSeeUsers() { return owner() || ['view', 'create', 'edit', 'delete'].some(action => canManageUsers(action)); }
function renderUserGroups(selected = []) {
  const current = new Map((selected || []).map(row => [row.group_id, row]));
  $('userGroupPermissions').innerHTML = managedGroups.filter(group => group.is_active).map(group => {
    const access = current.get(group.id) || {};
    const checks = Object.entries(groupPermissionLabels).map(([key, label]) => `<label><input type="checkbox" data-group-id="${escapeHtml(group.id)}" data-group-permission="${key}" ${access[key] ? 'checked' : ''} ${!owner() && key !== 'can_view' ? 'disabled' : ''}><span>${label}</span></label>`).join('');
    return `<div class="group-permission-row"><strong>${escapeHtml(group.name)}</strong>${checks}</div>`;
  }).join('') || '<span class="muted">Nenhum grupo ativo cadastrado.</span>';
}
function renderSystemPermissions(selected = {}) {
  $('userSystemPermissions').innerHTML = Object.entries(permissionLabels).map(([key, label]) => {
    const restricted = !owner() && key !== 'library_view';
    return `<label class="permission-check"><input type="checkbox" data-system-permission="${key}" ${selected[key] ? 'checked' : ''} ${restricted ? 'disabled' : ''}><span>${label}</span></label>`;
  }).join('');
  if (!owner()) $('userSystemPermissions').insertAdjacentHTML('beforeend', '<small class="muted full-field">Permissões administrativas só podem ser concedidas pelo administrador geral.</small>');
}
function renderUsers() {
  const list = $('usersList');
  list.replaceChildren();
  $('usersEmptyState').hidden = managedUsers.length > 0;
  $('newUserButton').hidden = !canManageUsers('create');
  managedUsers.forEach(user => {
    const groupNames = user.all_groups_access ? 'Todos os grupos' : (user.groupPermissions || []).map(row => managedGroups.find(group => group.id === row.group_id)?.name).filter(Boolean).join(', ');
    const badges = [user.is_owner ? 'Administrador geral' : (user.role === 'admin' ? 'Administrador' : user.role === 'leader' ? 'Líder' : 'Integrante'), user.is_active ? 'Ativo' : 'Inativo', groupNames || 'Sem grupos'].map((label, index) => `<span class="user-badge ${index === 1 && !user.is_active ? 'inactive' : ''}">${escapeHtml(label)}</span>`).join('');
    const actions = user.is_owner ? '' : `${canManageUsers('edit') ? `<button class="button-outline" data-user-action="edit" data-id="${escapeHtml(user.id)}" type="button">Editar</button><button class="button-outline" data-user-action="reset" data-id="${escapeHtml(user.id)}" type="button">Nova senha temporária</button>` : ''}${canManageUsers('delete') ? `<button class="button-quiet" data-user-action="toggle" data-active="${user.is_active ? 'true' : 'false'}" data-id="${escapeHtml(user.id)}" type="button">${user.is_active ? 'Desativar' : 'Reativar'}</button>` : ''}`;
    const card = document.createElement('article');
    card.className = 'user-card';
    card.innerHTML = `<div><h3>${escapeHtml(user.full_name)}</h3><p>${escapeHtml(user.phone)}</p><div class="user-badges">${badges}</div></div><div class="user-card-actions">${actions || (user.is_owner ? '<span class="muted">Conta principal protegida</span>' : '')}</div>`;
    list.append(card);
  });
}
async function loadUsers() {
  if (!canSeeUsers()) return;
  const result = await appApi('/api/users');
  managedUsers = result.users || [];
  managedGroups = result.groups || [];
  renderUsers();
}
function openUserForm(user = null) {
  $('userForm').reset();
  $('userId').value = user?.id || '';
  $('userName').value = user?.full_name || '';
  $('userPhone').value = user?.phone || '';
  $('userRole').value = user?.role || 'member';
  $('userActive').checked = user?.is_active !== false;
  $('allGroupsAccess').checked = user?.all_groups_access === true;
  renderUserGroups(user?.groupPermissions || []);
  renderSystemPermissions(user?.permissions || {});
  $('userFormTitle').textContent = user ? 'Editar usuário' : 'Novo usuário';
  $('userFormWrap').hidden = false;
  $('temporaryPasswordResult').hidden = true;
  if (!owner()) { $('userRole').disabled = true; $('allGroupsAccess').disabled = true; }
  $('userFormWrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function selectedGroupPermissions() {
  return managedGroups.filter(group => group.is_active).map(group => {
    const entry = { group_id: group.id };
    Object.keys(groupPermissionLabels).forEach(key => { entry[key] = Boolean(document.querySelector(`input[data-group-id="${CSS.escape(group.id)}"][data-group-permission="${key}"]`)?.checked); });
    return entry;
  }).filter(row => row.can_view || row.can_create || row.can_edit || row.can_delete);
}
function selectedSystemPermissions() {
  return Object.keys(permissionLabels).reduce((result, key) => { result[key] = Boolean(document.querySelector(`input[data-system-permission="${key}"]`)?.checked); return result; }, {});
}
function showTemporaryPassword(password) {
  $('temporaryPasswordText').textContent = password;
  $('temporaryPasswordResult').hidden = false;
  $('temporaryPasswordResult').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
async function saveUser(event) {
  event.preventDefault();
  const button = $('userForm').querySelector('button[type="submit"]');
  const id = $('userId').value;
  const body = { id, full_name: $('userName').value.trim(), phone: $('userPhone').value, role: $('userRole').value, is_active: $('userActive').checked, all_groups_access: $('allGroupsAccess').checked, group_permissions: selectedGroupPermissions(), permissions: selectedSystemPermissions() };
  button.disabled = true;
  try {
    const result = await appApi('/api/users', { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    $('userFormWrap').hidden = true;
    await loadUsers();
    if (result.temporaryPassword) showTemporaryPassword(result.temporaryPassword);
    message(id ? 'Usuário atualizado.' : 'Usuário criado. Copie a senha temporária e entregue em particular.', true);
  } catch (error) { message(error.message); }
  finally { button.disabled = false; }
}
async function handleUserAction(event) {
  const button = event.target.closest('button[data-user-action]');
  if (!button) return;
  const user = managedUsers.find(row => row.id === button.dataset.id);
  if (!user) return;
  const action = button.dataset.userAction;
  if (action === 'edit') return openUserForm(user);
  button.disabled = true;
  try {
    if (action === 'reset') {
      if (!window.confirm(`Gerar uma nova senha temporária para ${user.full_name}? A senha atual deixará de funcionar.`)) return;
      const result = await appApi('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reset_password', user_id: user.id }) });
      showTemporaryPassword(result.temporaryPassword);
      return message('Nova senha temporária gerada. Copie e entregue em particular.', true);
    }
    if (action === 'toggle') {
      const active = button.dataset.active !== 'true';
      if (!window.confirm(`${active ? 'Reativar' : 'Desativar'} o acesso de ${user.full_name}?`)) return;
      await appApi('/api/users', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...user, is_active: active, group_permissions: user.groupPermissions, permissions: user.permissions }) });
      await loadUsers();
      message(active ? 'Acesso reativado.' : 'Acesso desativado.', true);
    }
  } catch (error) { message(error.message); }
  finally { button.disabled = false; }
}
async function louvorApi(resource, method = 'GET', body = null, query = '') {
  const response = await fetch(`/api/louvor?resource=${encodeURIComponent(resource)}${query}`, {
    method,
    headers: { ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const data = await parseResponse(response, 'O servidor do painel retornou uma resposta inválida.');
  if (!response.ok) throw new Error(data?.error || 'Não foi possível concluir a operação.');
  return data;
}
function canGroup(action, group = selectedGroup) { return owner() || Boolean(group && profile?.groups?.some(row => row.id === group.id && row[`can_${action}`])); }
function canGroupModule(action) { return permitted(`groups_${action}`); }
function canSongModule(action) { return permitted(`library_${action}`); }
function canSeeGroups() { return owner() || profile?.all_groups_access === true || ['view','create','edit','delete'].some(action => permitted(`groups_${action}`)) || profile?.groups?.some(group => group.can_view); }
function canSeeSongs() { return owner() || profile?.all_groups_access === true || ['view','create','edit','delete'].some(action => permitted(`library_${action}`)) || profile?.groups?.some(group => group.can_view); }
function normalizedText(value) { return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').replace(/[^a-z0-9]+/g, ' ').trim(); }
const weekdayNames = ['Domingo','Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado'];
function renderGroupTiles() {
  $('groupsList').replaceChildren();
  $('groupsEmptyState').hidden = ministryGroups.length > 0;
  $('newGroupButton').hidden = !canGroupModule('create');
  $('importRepertoireButton').hidden = !owner() && !(profile?.groups || []).some(group => group.can_create);
  $('importGroupSelect').innerHTML = ministryGroups.filter(group => group.is_active && (owner() || canGroup('create', group))).map(group => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`).join('');
  ministryGroups.filter(group => group.is_active).forEach(group => {
    const access = profile?.groups?.find(row => row.id === group.id);
    const tile = document.createElement('article');
    tile.className = 'group-tile';
    tile.dataset.groupId = group.id;
    tile.innerHTML = `<div><span class="group-symbol">♫</span><h3>${escapeHtml(group.name)}</h3><p>${escapeHtml(weekdayNames[group.service_weekday] || 'Dia a definir')} · ${access?.can_create || access?.can_edit ? 'Escalas e repertórios do grupo' : 'Consulte as escalas e repertórios'}</p></div><div class="tile-actions">${canGroupModule('edit') ? `<button class="button-outline" data-group-action="edit" type="button">Editar</button>` : ''}${canGroupModule('delete') ? `<button class="button-quiet" data-group-action="deactivate" type="button">Desativar</button>` : ''}</div>`;
    tile.addEventListener('click', event => { if (!event.target.closest('button')) openGroup(group); });
    tile.querySelectorAll('button').forEach(button => button.addEventListener('click', event => { event.stopPropagation(); handleGroupAction(group, button.dataset.groupAction); }));
    $('groupsList').append(tile);
  });
}
async function loadGroups() {
  const [result, context] = await Promise.all([louvorApi('groups'), appApi('/api/me')]);
  ministryGroups = (result.groups || []).filter(group => group.is_active);
  profile = context.profile;
  renderGroupTiles();
}
async function handleGroupAction(group, action) {
  try {
    if (action === 'edit') {
      const name = window.prompt('Nome do grupo:', group.name);
      if (!name || !name.trim()) return;
      const weekdayText = window.prompt(`Dia habitual do culto: ${weekdayNames.map((day, index) => `${index}=${day}`).join(', ')}`, String(group.service_weekday ?? 0));
      if (weekdayText === null) return;
      const weekday = Number(weekdayText);
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return message('Informe um número de 0 a 6 para o dia da semana.');
      if (name.trim() === group.name && weekday === group.service_weekday) return;
      await louvorApi('groups', 'PATCH', { id: group.id, name: name.trim(), service_weekday: weekday });
      await loadGroups(); message('Grupo atualizado.', true);
    } else if (action === 'deactivate' && window.confirm(`Desativar o grupo ${group.name}? As escalas antigas serão preservadas.`)) {
      await louvorApi('groups', 'PATCH', { id: group.id, is_active: false });
      await loadGroups(); message('Grupo desativado.', true);
    }
  } catch (error) { message(error.message); }
}
async function createGroup() {
  const name = window.prompt('Nome do novo grupo:');
  if (!name || !name.trim()) return;
  const weekdayText = window.prompt(`Dia habitual do culto: ${weekdayNames.map((day, index) => `${index}=${day}`).join(', ')}`, '0');
  if (weekdayText === null) return;
  const weekday = Number(weekdayText);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return message('Informe um número de 0 a 6 para o dia da semana.');
  try { await louvorApi('groups', 'POST', { name: name.trim(), service_weekday: weekday }); await loadGroups(); message('Grupo criado. Configure os acessos na administração de usuários.', true); }
  catch (error) { message(error.message); }
}
function monthKey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; }
function fillMonthOptions(services = []) {
  const select = $('serviceMonth');
  const previous = select.value;
  const keys = new Set([monthKey(new Date()), ...services.map(service => String(service.service_date).slice(0, 7))]);
  const now = new Date();
  for (let offset = -24; offset <= 36; offset++) { const date = new Date(now.getFullYear(), now.getMonth() + offset, 1); keys.add(monthKey(date)); }
  const sorted = [...keys].sort().reverse();
  select.innerHTML = sorted.map(key => { const [year, month] = key.split('-').map(Number); const label = new Date(year, month - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }); return `<option value="${key}">${escapeHtml(label)}</option>`; }).join('');
  select.value = keys.has(previous) ? previous : (keys.has(monthKey(new Date())) ? monthKey(new Date()) : sorted[0]);
}
async function openGroup(group) {
  selectedGroup = group;
  $('groupsSection').hidden = true; $('servicesSection').hidden = false; $('songsSection').hidden = true;
  $('serviceGroupTitle').textContent = group.name;
  $('serviceGroupKicker').textContent = group.name.toLocaleUpperCase('pt-BR');
  $('newServiceButton').hidden = !canGroup('create', group);
  $('emptyNewServiceButton').hidden = !canGroup('create', group);
  $('serviceEditorWrap').hidden = true; $('serviceDetail').hidden = true;
  try { await loadSongs(); await loadServices(); } catch (error) { message(error.message); }
}
async function loadServices() {
  const result = await louvorApi('services', 'GET', null, `&group_id=${encodeURIComponent(selectedGroup.id)}`);
  const services = result.services || [];
  fillMonthOptions(services);
  renderServices(services);
}
function formatServiceDate(date) { return new Date(`${date}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' }); }
function renderServices(allServices) {
  const month = $('serviceMonth').value;
  const [year, monthNumber] = month.split('-').map(Number);
  const targetWeekday = Number.isInteger(selectedGroup.service_weekday) ? selectedGroup.service_weekday : 0;
  const lastDay = new Date(year, monthNumber, 0).getDate();
  const existingByDate = new Map(allServices.filter(service => String(service.service_date).startsWith(month)).map(service => [service.service_date, service]));
  const dates = [];
  for (let day = 1; day <= lastDay; day++) {
    const date = new Date(year, monthNumber - 1, day, 12);
    if (date.getDay() === targetWeekday) dates.push(`${year}-${String(monthNumber).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  }
  $('servicesList').replaceChildren(); $('servicesEmptyState').hidden = dates.length > 0;
  dates.forEach(date => {
    const service = existingByDate.get(date);
    const card = document.createElement('article'); card.className = 'service-tile';
    const dateLabel = new Date(`${date}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const themeLabel = service?.theme || 'Tema a definir';
    card.innerHTML = `<span class="service-date">${escapeHtml(formatServiceDate(date))}</span><h3>Repertório · ${escapeHtml(dateLabel)}</h3><p class="theme">Tema: ${escapeHtml(themeLabel)}</p><p>${service ? 'Escala cadastrada · clique para consultar' : (canGroup('create') ? 'Clique para preparar esta escala' : 'Escala ainda não publicada')}</p>`;
    card.addEventListener('click', () => service ? openService(service.id) : (canGroup('create') ? openServiceEditor(null, { service_date: date }) : null));
    $('servicesList').append(card);
  });
}
function defaultServiceDate(group) {
  const target = Number.isInteger(group.service_weekday) ? group.service_weekday : (normalizedText(group.name).includes('oracao') ? 4 : 0);
  const date = new Date(); date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + ((target - date.getDay() + 7) % 7));
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
async function openService(id) {
  try {
    const result = await louvorApi('service', 'GET', null, `&id=${encodeURIComponent(id)}`);
    renderServiceDetail(result.service);
  } catch (error) { message(error.message); }
}
function renderServiceDetail(service) {
  currentService = service;
  const singers = service.people.filter(person => person.role === 'singer').map(person => `<li>${escapeHtml(person.name)}</li>`).join('') || '<li>A definir</li>';
  const musicians = service.people.filter(person => person.role === 'musician').map(person => `<li>${escapeHtml(person.name)}</li>`).join('') || '<li>A definir</li>';
  const songs = service.songs.map((song, index) => { const youtube = safeExternalUrl(song.youtube_url_snapshot); const chart = safeExternalUrl(song.chart_url_snapshot); return `<div class="service-detail-song"><strong>${index + 1}. ${escapeHtml(song.title_snapshot)}</strong>${song.artist_snapshot ? ` — ${escapeHtml(song.artist_snapshot)}` : ''}${song.soloist ? `<p>🎤 Solista: ${escapeHtml(song.soloist)}</p>` : ''}${song.male_key_snapshot ? `<p>Tom masculino: ${escapeHtml(song.male_key_snapshot)}</p>` : ''}${song.female_key_snapshot ? `<p>Tom feminino: ${escapeHtml(song.female_key_snapshot)}</p>` : ''}<p>${youtube ? `▶ <a href="${escapeHtml(youtube)}" target="_blank" rel="noopener">YouTube</a>　` : ''}${chart ? `🎸 <a href="${escapeHtml(chart)}" target="_blank" rel="noopener">Cifra</a>` : ''}</p></div>`; }).join('') || '<p>Nenhuma música adicionada.</p>';
  $('serviceDetail').innerHTML = `<div class="section-heading"><div><span class="section-kicker">${escapeHtml(selectedGroup.name.toLocaleUpperCase('pt-BR'))}</span><h3>Escala de ${escapeHtml(new Date(`${service.service_date}T12:00:00`).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }))}</h3><p>${escapeHtml(formatServiceDate(service.service_date))} · Tema: ${escapeHtml(service.theme || 'A definir')}</p></div><div class="admin-actions"><button class="button-quiet" id="serviceBackButton" type="button">Voltar</button>${canGroup('edit', selectedGroup) ? `<button class="button-outline" id="editServiceButton" type="button">Editar escala</button>` : ''}</div></div><h4>👥 CANTORES</h4><ul>${singers}</ul><h4>🎸 MÚSICOS</h4><ul>${musicians}</ul><h4>🎵 REPERTÓRIO</h4>${songs}<details class="snapshot-details"><summary>Histórico de alterações (${service.snapshots.length})</summary><ol class="snapshots-list">${service.snapshots.map(row => `<li>${escapeHtml(formatDate(row.created_at))}</li>`).join('') || '<li>Nenhuma alteração anterior.</li>'}</ol></details>`;
  $('servicesList').hidden = true; $('servicesEmptyState').hidden = true; $('serviceDetail').hidden = false;
  $('serviceBackButton').addEventListener('click', () => { $('serviceDetail').hidden = true; $('servicesList').hidden = false; loadServices().catch(error => message(error.message)); });
  $('editServiceButton')?.addEventListener('click', () => openServiceEditor(service));
}
function renderServiceSongRows(songs = []) {
  $('serviceSongRows').innerHTML = songs.map((song, index) => `<div class="service-song-editor" data-song-row><div class="service-song-editor-head"><strong>Música ${index + 1}</strong><div class="tile-actions">${song.song_id ? '' : '<button class="button-outline" type="button" data-register-song>Adicionar à biblioteca</button>'}<button class="button-quiet" type="button" data-remove-song>Remover</button></div></div><input type="hidden" data-field="song_id" value="${escapeHtml(song.song_id || '')}"><div class="service-song-editor-grid"><label>Título<input data-field="title_snapshot" maxlength="200" value="${escapeHtml(song.title_snapshot || '')}" required></label><label>Artista / compositor<input data-field="artist_snapshot" value="${escapeHtml(song.artist_snapshot || '')}"></label><label>Solista(s)<input data-field="soloist" value="${escapeHtml(song.soloist || '')}"></label><label>Tom masculino<input data-field="male_key_snapshot" value="${escapeHtml(song.male_key_snapshot || '')}"></label><label>Tom feminino<input data-field="female_key_snapshot" value="${escapeHtml(song.female_key_snapshot || '')}"></label><label>YouTube<input data-field="youtube_url_snapshot" type="url" value="${escapeHtml(song.youtube_url_snapshot || '')}"></label><label>Cifra<input data-field="chart_url_snapshot" type="url" value="${escapeHtml(song.chart_url_snapshot || '')}"></label></div></div>`).join('');
  $('serviceSongRows').querySelectorAll('[data-remove-song]').forEach(button => button.addEventListener('click', () => { button.closest('[data-song-row]').remove(); renumberServiceSongs(); }));
  $('serviceSongRows').querySelectorAll('[data-register-song]').forEach(button => button.addEventListener('click', () => {
    const row = button.closest('[data-song-row]');
    const value = key => row.querySelector(`[data-field="${key}"]`).value.trim();
    const index = [...$('serviceSongRows').querySelectorAll('[data-song-row]')].indexOf(row);
    openSongForm({ title: value('title_snapshot'), artist: value('artist_snapshot'), male_key: value('male_key_snapshot'), female_key: value('female_key_snapshot'), youtube_url: value('youtube_url_snapshot'), chart_url: value('chart_url_snapshot') }, true, index);
  }));
}
function renumberServiceSongs() { $('serviceSongRows').querySelectorAll('[data-song-row] strong').forEach((node, index) => { node.textContent = `Música ${index + 1}`; }); }
function addServiceSong(song = {}) {
  const current = readServiceSongRows();
  if (current.length >= 8) return message('Cada escala pode ter no máximo oito músicas.');
  current.push({ song_id: song.id || song.song_id || '', title_snapshot: song.title || song.title_snapshot || '', artist_snapshot: [song.artist, song.composer].filter(Boolean).join(' · ') || song.artist_snapshot || '', soloist: song.soloist || '', male_key_snapshot: song.male_key || song.male_key_snapshot || '', female_key_snapshot: song.female_key || song.female_key_snapshot || '', youtube_url_snapshot: song.youtube_url || song.youtube_url_snapshot || '', chart_url_snapshot: song.chart_url || song.chart_url_snapshot || '' });
  renderServiceSongRows(current);
}
function readServiceSongRows() {
  return [...$('serviceSongRows').querySelectorAll('[data-song-row]')].map(row => Object.fromEntries([...row.querySelectorAll('[data-field]')].map(input => [input.dataset.field, input.value.trim()])));
}
async function openServiceEditor(service = null, draft = null) {
  if (!service && !draft && !canGroup('create')) return message('Você não tem permissão para criar escalas neste grupo.');
  $('serviceId').value = service?.id || '';
  $('serviceDate').value = service?.service_date || draft?.service_date || defaultServiceDate(selectedGroup);
  $('serviceTheme').value = service?.theme || draft?.theme || '';
  $('serviceSingers').value = service?.people.filter(row => row.role === 'singer').map(row => row.name).join('\n') || (draft?.singers || []).join('\n');
  $('serviceMusicians').value = service?.people.filter(row => row.role === 'musician').map(row => row.name).join('\n') || (draft?.musicians || []).join('\n');
  renderServiceSongRows(service?.songs || draft?.songs || []);
  $('serviceEditorTitle').textContent = service ? 'Editar escala' : 'Nova escala';
  $('serviceDetail').hidden = true; $('servicesList').hidden = false; $('serviceEditorWrap').hidden = false;
  await loadSongs(); fillSongPicker();
  $('serviceEditorWrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function fillSongPicker() { $('songCatalogPicker').innerHTML = '<option value="">Selecione uma música</option>' + songCatalog.map(song => `<option value="${escapeHtml(song.id)}">${escapeHtml(song.title)}${song.artist ? ` — ${escapeHtml(song.artist)}` : ''}</option>`).join(''); }
async function saveServiceForm(event) {
  event.preventDefault();
  const id = $('serviceId').value;
  const songs = readServiceSongRows();
  if (songs.length > 8) return message('Cada escala pode ter no máximo oito músicas.');
  const names = input => input.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const body = { id, group_id: selectedGroup.id, service_date: $('serviceDate').value, theme: $('serviceTheme').value.trim(), people: [...names($('serviceSingers').value).map(name => ({ role: 'singer', name })), ...names($('serviceMusicians').value).map(name => ({ role: 'musician', name }))], songs };
  const button = $('serviceForm').querySelector('button[type="submit"]'); button.disabled = true;
  try { await louvorApi('service', id ? 'PATCH' : 'POST', body); $('serviceEditorWrap').hidden = true; await loadServices(); message('Escala salva no banco de dados.', true); }
  catch (error) { message(error.message); }
  finally { button.disabled = false; }
}
async function loadSongs(search = '') {
  const result = await louvorApi('songs', 'GET', null, search ? `&q=${encodeURIComponent(search)}` : '');
  songCatalog = result.songs || [];
  fillSongPicker(); renderSongCatalog();
}
function renderSongCatalog() {
  const list = $('songsList'); list.replaceChildren();
  $('newCatalogSongButton').hidden = !canSongModule('create');
  $('newSongFromServiceButton').hidden = !canSongModule('create');
  const query = normalizedText($('songSearch').value);
  songCatalog.filter(song => !query || normalizedText(`${song.title} ${song.artist} ${song.composer} ${song.themes}`).includes(query)).forEach(song => {
    const card = document.createElement('article'); card.className = 'song-catalog-card';
    const youtube = safeExternalUrl(song.youtube_url); const chart = safeExternalUrl(song.chart_url);
    const links = `${youtube ? `<a href="${escapeHtml(youtube)}" target="_blank" rel="noopener">YouTube</a>` : ''}${chart ? `<a href="${escapeHtml(chart)}" target="_blank" rel="noopener">Cifra</a>` : ''}`;
    card.innerHTML = `<h3>${escapeHtml(song.title)}</h3><p>${escapeHtml([song.artist, song.composer].filter(Boolean).join(' · ') || 'Artista/compositor a definir')}</p><p>Tom masc.: ${escapeHtml(song.male_key || '—')} · Tom fem.: ${escapeHtml(song.female_key || '—')}</p><p>Temas: ${escapeHtml(song.themes || '—')}</p><div class="song-links">${links}</div><div class="tile-actions">${canSongModule('edit') ? '<button class="button-outline" data-song-action="edit" type="button">Editar</button>' : ''}${canSongModule('delete') ? '<button class="button-quiet" data-song-action="delete" type="button">Excluir</button>' : ''}</div>`;
    card.querySelector('[data-song-action="edit"]')?.addEventListener('click', () => openSongForm(song));
    card.querySelector('[data-song-action="delete"]')?.addEventListener('click', async () => { if (!window.confirm(`Excluir ${song.title} da biblioteca? Escalas antigas mantêm seus dados.`)) return; try { await louvorApi('songs', 'DELETE', { id: song.id }); await loadSongs($('songSearch').value.trim()); message('Música excluída da biblioteca.', true); } catch (error) { message(error.message); } });
    list.append(card);
  });
}
function openSongForm(song = null, fromService = false, serviceRowIndex = null) {
  returnToServiceEditor = fromService;
  returnToServiceRow = serviceRowIndex;
  $('songId').value = song?.id || ''; $('songTitle').value = song?.title || ''; $('songArtist').value = song?.artist || ''; $('songComposer').value = song?.composer || '';
  $('songThemes').value = song?.themes || ''; $('songMaleKey').value = song?.male_key || ''; $('songFemaleKey').value = song?.female_key || '';
  $('songYoutube').value = song?.youtube_url || ''; $('songChart').value = song?.chart_url || '';
  $('songFormTitle').textContent = song ? 'Editar música' : 'Nova música'; $('songFormWrap').hidden = false;
  if (fromService) { $('servicesSection').hidden = true; $('songsSection').hidden = false; }
  $('songFormWrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
async function saveSongForm(event) {
  event.preventDefault(); const id = $('songId').value;
  const body = { id, title: $('songTitle').value.trim(), artist: $('songArtist').value.trim(), composer: $('songComposer').value.trim(), themes: $('songThemes').value.trim(), male_key: $('songMaleKey').value.trim(), female_key: $('songFemaleKey').value.trim(), youtube_url: $('songYoutube').value.trim(), chart_url: $('songChart').value.trim() };
  const button = $('songForm').querySelector('button[type="submit"]'); button.disabled = true;
  try {
    const result = await louvorApi('songs', id ? 'PATCH' : 'POST', body); $('songFormWrap').hidden = true; await loadSongs($('songSearch').value.trim());
    if (returnToServiceEditor && !id) {
      $('songsSection').hidden = true; $('servicesSection').hidden = false; $('serviceEditorWrap').hidden = false;
      if (returnToServiceRow === null) addServiceSong(result.song);
      else {
        const row = $('serviceSongRows').querySelectorAll('[data-song-row]')[returnToServiceRow];
        if (row) {
          row.querySelector('[data-field="song_id"]').value = result.song.id;
          const values = { artist_snapshot: [result.song.artist, result.song.composer].filter(Boolean).join(' · '), male_key_snapshot: result.song.male_key, female_key_snapshot: result.song.female_key, youtube_url_snapshot: result.song.youtube_url, chart_url_snapshot: result.song.chart_url };
          Object.entries(values).forEach(([key, value]) => { const field = row.querySelector(`[data-field="${key}"]`); if (!field.value && value) field.value = value; });
          const draft = readServiceSongRows(); renderServiceSongRows(draft);
        }
      }
      returnToServiceEditor = false; returnToServiceRow = null;
    }
    message(id ? 'Música atualizada.' : 'Música cadastrada na biblioteca.', true);
  } catch (error) { message(error.message); }
  finally { button.disabled = false; }
}
function parseRepertoireText(text) {
  const monthNames = ['janeiro','fevereiro','marco','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
  const normalized = normalizedText(text);
  const month = monthNames.findIndex(name => normalized.includes(name));
  const yearMatch = text.match(/20\d{2}/);
  if (month < 0 || !yearMatch) throw new Error('Não encontrei mês e ano no texto. Inclua um cabeçalho como “Novembro - 2026”.');
  const year = Number(yearMatch[0]);
  const lines = text.split(/\r?\n/);
  const groups = ministryGroups.filter(group => {
    const name = normalizedText(group.name);
    const aliases = name === 'culto publico' ? ['cultos publicos', 'culto publico'] : name === 'culto de oracao' ? ['cultos de oracao', 'culto de oracao'] : name === 'ebd' ? ['ebd', 'escola biblica dominical'] : [name];
    return aliases.some(alias => normalized.includes(alias));
  });
  let group = groups[0] || selectedGroup || ministryGroups.find(item => item.id === $('importGroupSelect').value);
  if (!group) throw new Error('Não identifiquei o grupo no cabeçalho. Selecione um grupo antes de importar.');
  const weekHeaders = [];
  lines.forEach((line, index) => { const match = line.match(/^\s*(\d+)\s*[ªº]?\s*SEMANA\s*[–—-]\s*TEMA\s*:\s*(.*)$/i); if (match) weekHeaders.push({ index, week: Number(match[1]), theme: match[2].trim() }); });
  if (!weekHeaders.length) throw new Error('Não encontrei semanas. Use títulos como “1ª SEMANA – Tema: ...”.');
  const weekday = Number.isInteger(group.service_weekday) ? group.service_weekday : (normalizedText(group.name).includes('oracao') ? 4 : 0);
  const drafts = weekHeaders.map((header, index) => {
    const end = weekHeaders[index + 1]?.index ?? lines.length;
    let section = '';
    const singers = [], musicians = [], songs = [];
    for (const original of lines.slice(header.index + 1, end)) {
      const line = original.trim();
      if (!line) continue;
      const key = normalizedText(line).replace(/:$/, '');
      if (key === 'cantores') { section = 'singers'; continue; }
      if (key === 'musicos') { section = 'musicians'; continue; }
      if (key === 'musicas' || key === 'louvores') { section = 'songs'; continue; }
      if (!section) continue;
      const value = line.replace(/^\s*(?:\d+\s*[.)-]?|[-•*])\s*/, '').trim();
      if (!value) continue;
      if (section === 'singers' || section === 'musicians') { (section === 'singers' ? singers : musicians).push(value); continue; }
      let title = value.replace(/^\s*\d+\s*[.)-]?\s*/, '').trim();
      const soloMatches = [...title.matchAll(/\bsolista\b\s*[,;:]?\s*([^()]+)?/gi)];
      let soloist = soloMatches.map(match => (match[1] || '').replace(/^\s*[,;:–—-]+/, '').trim()).filter(Boolean).join(', ');
      const parens = [...title.matchAll(/\(([^)]*)\)/g)].map(match => match[1].trim());
      const hasSoloistLabel = /\bsolista\b/i.test(title.replace(/\([^)]*\)/g, ''));
      const knownArtist = parens.find(item => /minist[eé]rio|banda|fernandinho|avivah|morada|vineyard/i.test(item));
      let artist = hasSoloistLabel ? (parens[0] || '') : (knownArtist || '');
      if (!soloist && parens.length && !artist) {
        const candidate = parens[parens.length - 1];
        if (/todos/i.test(candidate)) soloist = 'Todos';
        else if (!/prel[uú]dio/i.test(candidate)) soloist = candidate.replace(/^solista\s*/i, '').trim();
      }
      title = title.replace(/\s*\([^)]*\)/g, '').replace(/\bsolista\b\s*[,;:]?\s*[^()]+/gi, '').trim().replace(/[–—-]\s*$/, '');
      if (title) songs.push({ song_id: '', title_snapshot: title, artist_snapshot: artist, soloist, male_key_snapshot: '', female_key_snapshot: '', youtube_url_snapshot: '', chart_url_snapshot: '' });
    }
    const date = new Date(year, month, 1, 12); let seen = 0;
    while (seen < header.week) { if (date.getDay() === weekday) seen++; if (seen < header.week) date.setDate(date.getDate() + 1); }
    if (date.getMonth() !== month) throw new Error(`A semana ${header.week} não corresponde a um ${weekdayNames[weekday]} neste mês. Confira o número da semana no arquivo.`);
    const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return { group_id: group.id, service_date: iso, theme: header.theme, singers, musicians, songs };
  });
  if (drafts.some(draft => draft.songs.length > 8)) throw new Error('Uma semana tem mais de oito músicas. Reduza o repertório antes de salvar.');
  return drafts;
}
function renderImportPreview() {
  importDraft = parseRepertoireText($('repertoireText').value);
  $('importPreview').innerHTML = importDraft.map(draft => `<article class="import-preview-card"><h4>${escapeHtml(formatServiceDate(draft.service_date))} · ${escapeHtml(draft.theme)}</h4><p>${draft.singers.length} cantores · ${draft.musicians.length} músicos · ${draft.songs.length} músicas</p><p>${draft.songs.map(song => escapeHtml(song.title_snapshot)).join(' · ')}</p></article>`).join('');
  $('importPreview').hidden = false; $('saveImportButton').disabled = false;
}
async function saveImportDraft() {
  if (!importDraft.length) return;
  $('saveImportButton').disabled = true;
  try {
    await loadSongs();
    const existingByDate = new Map();
    const groupId = importDraft[0].group_id;
    const existing = await louvorApi('services', 'GET', null, `&group_id=${encodeURIComponent(groupId)}`);
    (existing.services || []).forEach(service => existingByDate.set(service.service_date, service));
    const hasExisting = importDraft.some(draft => existingByDate.has(draft.service_date));
    if (hasExisting && !window.confirm('Há datas que já possuem escala. Deseja substituir os dados dessas datas? O sistema guardará um histórico da versão anterior.')) return;
    for (const draft of importDraft) {
      draft.songs = draft.songs.map(song => {
        const found = songCatalog.find(item => normalizedText(item.title) === normalizedText(song.title_snapshot));
        return found ? { ...song, song_id: found.id, artist_snapshot: song.artist_snapshot || found.artist, male_key_snapshot: found.male_key, female_key_snapshot: found.female_key, youtube_url_snapshot: found.youtube_url, chart_url_snapshot: found.chart_url } : song;
      });
      const old = existingByDate.get(draft.service_date);
      await louvorApi('service', old ? 'PATCH' : 'POST', { ...draft, ...(old ? { id: old.id } : {}), people: [...draft.singers.map(name => ({ role: 'singer', name })), ...draft.musicians.map(name => ({ role: 'musician', name }))] });
    }
    $('importWrap').hidden = true; await loadGroups(); message(`${importDraft.length} escalas importadas. Complete os links, tons e músicas pendentes.`, true); importDraft = [];
  } catch (error) { message(error.message); }
  finally { $('saveImportButton').disabled = false; }
}
function activatePanelSection(id) {
  const sections = ['groupsSection','servicesSection','songsSection','librarySection','personalNotesSection','userAdminSection'];
  sections.forEach(section => { if (section === 'userAdminSection' && !canSeeUsers()) $(section).hidden = true; else $(section).hidden = section !== id; });
  document.querySelectorAll('.sidebar .nav-link').forEach(link => link.classList.toggle('active', link.getAttribute('href') === `#${id}`));
  if (id === 'librarySection') loadData().catch(error => message(error.message));
  if (id === 'songsSection') loadSongs($('songSearch').value.trim()).catch(error => message(error.message));
  if (id === 'userAdminSection') loadUsers().catch(error => message(error.message));
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
  $('usersNavLink').hidden = !canSeeUsers();
  $('groupsNavLink').hidden = !canSeeGroups();
  $('songsNavLink').hidden = !canSeeSongs();
  $('libraryNavLink').hidden = !permitted('library_view');
  $('usersNavLink').addEventListener('click', event => { event.preventDefault(); if (canSeeUsers()) activatePanelSection('userAdminSection'); });
  $('newUserButton').addEventListener('click', () => openUserForm());
  $('cancelUserButton').addEventListener('click', () => { $('userFormWrap').hidden = true; });
  $('cancelUserButtonBottom').addEventListener('click', () => { $('userFormWrap').hidden = true; });
  $('userForm').addEventListener('submit', saveUser);
  $('usersList').addEventListener('click', handleUserAction);
  $('copyTemporaryPassword').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('temporaryPasswordText').textContent); message('Senha copiada. Entregue-a diretamente ao usuário.', true); } catch { message('Não foi possível copiar automaticamente. Selecione e copie a senha.'); } });
  $('groupsNavLink').addEventListener('click', event => { event.preventDefault(); selectedGroup = null; activatePanelSection('groupsSection'); loadGroups().catch(error => message(error.message)); });
  $('songsNavLink').addEventListener('click', event => { event.preventDefault(); activatePanelSection('songsSection'); });
  $('libraryNavLink').addEventListener('click', event => { event.preventDefault(); activatePanelSection('librarySection'); });
  $('notesNavLink').addEventListener('click', event => { event.preventDefault(); activatePanelSection('personalNotesSection'); });
  $('newGroupButton').addEventListener('click', createGroup);
  $('backToGroupsButton').addEventListener('click', () => { activatePanelSection('groupsSection'); loadGroups().catch(error => message(error.message)); });
  $('newServiceButton').addEventListener('click', () => openServiceEditor());
  $('emptyNewServiceButton').addEventListener('click', () => openServiceEditor());
  $('serviceMonth').addEventListener('change', () => { loadServices().catch(error => message(error.message)); });
  $('serviceForm').addEventListener('submit', saveServiceForm);
  $('cancelServiceButton').addEventListener('click', () => { $('serviceEditorWrap').hidden = true; });
  $('cancelServiceBottomButton').addEventListener('click', () => { $('serviceEditorWrap').hidden = true; });
  $('addCatalogSongButton').addEventListener('click', () => { const song = songCatalog.find(row => row.id === $('songCatalogPicker').value); if (song) addServiceSong(song); });
  $('newSongFromServiceButton').addEventListener('click', () => openSongForm(null, true));
  $('newCatalogSongButton').addEventListener('click', () => openSongForm());
  $('songSearch').addEventListener('input', () => renderSongCatalog());
  $('songForm').addEventListener('submit', saveSongForm);
  $('cancelSongButton').addEventListener('click', () => { $('songFormWrap').hidden = true; });
  $('cancelSongBottomButton').addEventListener('click', () => { $('songFormWrap').hidden = true; });
  $('importRepertoireButton').addEventListener('click', () => { $('importWrap').hidden = false; $('importRepertoireButton').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  $('closeImportButton').addEventListener('click', () => { $('importWrap').hidden = true; });
  $('repertoireFile').addEventListener('change', async event => { const file = event.target.files?.[0]; if (file) $('repertoireText').value = await file.text(); });
  $('previewImportButton').addEventListener('click', () => { try { renderImportPreview(); } catch (error) { $('importPreview').hidden = true; $('saveImportButton').disabled = true; message(error.message); } });
  $('saveImportButton').addEventListener('click', saveImportDraft);
  const startSection = canSeeGroups() ? 'groupsSection' : canSeeSongs() ? 'songsSection' : canSeeUsers() ? 'userAdminSection' : 'personalNotesSection';
  activatePanelSection(startSection);
  if (canSeeGroups()) loadGroups().catch(error => message(error.message));
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
