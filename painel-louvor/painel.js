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
let groupServices = [];
let userSearchState = '';
let selectedGroup = null;
let importDraft = [];
let returnToServiceEditor = false;
let returnToServiceRow = null;
let dashboardInitialized = false;
let agendaMonth = monthKey(new Date());
let agendaEvents = [];
let groupPeopleCache = new Map();
const servicePersonSelections = { singer: new Map(), musician: new Map() };
const PROJECT_START_MONTH = '2026-11';

function showView(id) {
  views.forEach(view => { $(view).hidden = view !== id; });
  $('feedback').textContent = '';
  $('feedback').className = 'feedback';
  const loginFeedback = $('loginFeedback');
  if (loginFeedback) { loginFeedback.textContent = ''; loginFeedback.hidden = true; }
}
function closeEditor(editorId, formId = '') {
  const form = formId ? $(formId) : null;
  const importHasContent = editorId === 'importWrap' && Boolean($('repertoireText').value.trim());
  if ((form?.dataset.dirty === 'true' || importHasContent) && !window.confirm('Há alterações ainda não salvas. Deseja descartá-las?')) return;
  $(editorId).hidden = true;
}
function setupModalEditors() {
  document.querySelectorAll('.editor-card form').forEach(form => {
    form.dataset.dirty = 'false';
    form.addEventListener('input', () => { form.dataset.dirty = 'true'; });
    form.addEventListener('change', () => { form.dataset.dirty = 'true'; });
    form.addEventListener('click', event => { if (event.target.closest('[data-remove-song], #addCatalogSongButton, #newSongFromServiceButton')) form.dataset.dirty = 'true'; });
  });
  const labels = { groupFormWrap: 'groupFormTitle', importWrap: 'importDialogTitle', serviceEditorWrap: 'serviceEditorTitle', songFormWrap: 'songFormTitle', itemFormWrap: 'itemFormTitle', userFormWrap: 'userFormTitle' };
  let activeModal = null;
  const observer = new MutationObserver(() => {
    const visible = [...document.querySelectorAll('.editor-card')].filter(editor => !editor.hidden && editor.closest('[hidden]') === null);
    const current = visible.at(-1) || null;
    document.body.classList.toggle('modal-open', Boolean(current));
    if (current) {
      current.setAttribute('role', 'dialog'); current.setAttribute('aria-modal', 'true');
      if (labels[current.id]) current.setAttribute('aria-labelledby', labels[current.id]);
      if (current !== activeModal) {
        activeModal = current;
        requestAnimationFrame(() => current.querySelector('input:not([type="hidden"]),select,textarea,button')?.focus({ preventScroll: true }));
      }
    } else activeModal = null;
  });
  observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
}
function openMobileMenu() { document.body.classList.add('mobile-menu-open'); $('mobileMenuButton').setAttribute('aria-expanded', 'true'); }
function closeMobileMenu() { document.body.classList.remove('mobile-menu-open'); $('mobileMenuButton').setAttribute('aria-expanded', 'false'); }
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
function formatPhone(digits) {
  if (!digits) return '';
  if (digits.length <= 2) return `(${digits}`;
  const area = digits.slice(0, 2);
  const subscriber = digits.slice(2);
  if (subscriber.length <= 4) return `(${area}) ${subscriber}`;
  if (subscriber.length <= 8) return `(${area}) ${subscriber.slice(0, 4)}-${subscriber.slice(4)}`;
  return `(${area}) ${subscriber.slice(0, 5)}-${subscriber.slice(5, 9)}`;
}
function maskPhoneInput(input) {
  const caret = input.selectionStart ?? input.value.length;
  const digitsBeforeCaret = input.value.slice(0, caret).replace(/\D/g, '').length;
  const digits = input.value.replace(/\D/g, '').slice(0, 11);
  input.value = formatPhone(digits);
  if (document.activeElement !== input) return;
  let position = 0;
  let counted = 0;
  while (position < input.value.length && counted < digitsBeforeCaret) {
    if (/\d/.test(input.value[position])) counted++;
    position++;
  }
  input.setSelectionRange(position, position);
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
  if (!response.ok) throw Object.assign(new Error(data?.error || 'Não foi possível concluir a operação.'), { status: response.status });
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
  $('itemForm').dataset.dirty = 'false';
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
  library_view: 'Consultar biblioteca musical', library_create: 'Cadastrar músicas e repertórios', library_edit: 'Editar músicas e repertórios', library_delete: 'Excluir músicas e repertórios',
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
  const query = normalizedText($('userSearch').value);
  const status = $('userStatusFilter').value;
  const visibleUsers = managedUsers.filter(user => (!query || normalizedText(`${user.full_name} ${user.phone}`).includes(query)) && (status === 'all' || (status === 'active' ? user.is_active : !user.is_active)));
  $('userCount').textContent = `${visibleUsers.length} de ${managedUsers.length} ${managedUsers.length === 1 ? 'usuário' : 'usuários'}`;
  $('usersEmptyState').hidden = managedUsers.length > 0;
  $('usersNoResults').hidden = managedUsers.length === 0 || visibleUsers.length > 0;
  $('newUserButton').hidden = !canManageUsers('create');
  visibleUsers.forEach(user => {
    const groupNames = user.all_groups_access ? 'Todos os grupos' : (user.groupPermissions || []).map(row => managedGroups.find(group => group.id === row.group_id)?.name).filter(Boolean).join(', ');
    const badges = [user.is_owner ? 'Administrador geral' : (user.role === 'admin' ? 'Administrador' : 'Integrante'), user.is_active ? 'Ativo' : 'Inativo', groupNames || 'Sem grupos'].map((label, index) => `<span class="user-badge ${index === 1 && !user.is_active ? 'inactive' : ''}">${escapeHtml(label)}</span>`).join('');
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
  $('userForm').dataset.dirty = 'false';
  $('presetAllGroupsViewer').hidden = !owner();
  $('presetPrayerEbdViewer').hidden = !owner();
  $('clearGroupPermissions').hidden = !owner();
  $('userFormWrap').hidden = false;
  $('temporaryPasswordResult').hidden = true;
  if (!owner()) { $('userRole').disabled = true; $('allGroupsAccess').disabled = true; }
  $('userFormWrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function applyGroupPreset(preset) {
  $('allGroupsAccess').checked = false;
  document.querySelectorAll('#userGroupPermissions input[data-group-permission]').forEach(input => { input.checked = false; });
  if (preset === 'all') $('allGroupsAccess').checked = true;
  if (preset === 'prayer-ebd') {
    managedGroups.filter(group => /oracao|ebd|escola biblica/i.test(normalizedText(group.name))).forEach(group => {
      const input = document.querySelector(`#userGroupPermissions input[data-group-id="${CSS.escape(group.id)}"][data-group-permission="can_view"]`);
      if (input) input.checked = true;
    });
  }
  $('userForm').dataset.dirty = 'true';
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
async function loadGroupPeople(groupId, refresh = false) {
  if (!refresh && groupPeopleCache.has(groupId)) return groupPeopleCache.get(groupId);
  const result = await louvorApi('people', 'GET', null, `&group_id=${encodeURIComponent(groupId)}`);
  const people = result.people || [];
  groupPeopleCache.set(groupId, people);
  return people;
}
function rememberPersonSelections(role) {
  const root = $(role === 'singer' ? 'serviceSingerLinks' : 'serviceMusicianLinks');
  root?.querySelectorAll('[data-person-link]').forEach(select => {
    servicePersonSelections[role].set(normalizedText(select.dataset.personName), select.value);
  });
}
function renderServicePersonLinks(role) {
  rememberPersonSelections(role);
  const input = $(role === 'singer' ? 'serviceSingers' : 'serviceMusicians');
  const root = $(role === 'singer' ? 'serviceSingerLinks' : 'serviceMusicianLinks');
  const names = input.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const directory = groupPeopleCache.get(selectedGroup.id) || [];
  const selections = servicePersonSelections[role];
  root.innerHTML = names.map(name => {
    const key = normalizedText(name);
    const matches = directory.filter(person => normalizedText(person.full_name) === key);
    if (!selections.has(key) && matches.length === 1) selections.set(key, matches[0].id);
    let selectedId = selections.get(key) || '';
    const exists = directory.some(person => person.id === selectedId);
    const currentOption = selectedId && !exists ? `<option value="${escapeHtml(selectedId)}" selected>Vínculo atual (conta indisponível)</option>` : '';
    return `<label class="person-link-row"><span>${escapeHtml(name)}</span><select data-person-link data-person-name="${escapeHtml(name)}" aria-label="Conta correspondente a ${escapeHtml(name)}"><option value="">Sem vínculo com uma conta</option>${currentOption}${directory.map(person => `<option value="${escapeHtml(person.id)}" ${person.id === selectedId ? 'selected' : ''}>${escapeHtml(person.full_name)}</option>`).join('')}</select></label>`;
  }).join('') || '<small class="person-link-empty">Adicione nomes acima para associá-los às contas.</small>';
  root.querySelectorAll('[data-person-link]').forEach(select => select.addEventListener('change', () => selections.set(normalizedText(select.dataset.personName), select.value)));
}
function servicePersonRows(role, value) {
  rememberPersonSelections(role);
  const directory = groupPeopleCache.get(selectedGroup.id) || [];
  return value.split(/\r?\n/).map(name => name.trim()).filter(Boolean).map(name => {
    const key = normalizedText(name);
    const selected = servicePersonSelections[role].has(key) ? servicePersonSelections[role].get(key) : '';
    const matches = directory.filter(person => normalizedText(person.full_name) === key);
    const profileId = servicePersonSelections[role].has(key) ? selected : (matches.length === 1 ? matches[0].id : '');
    return { role, name, profile_id: profileId || null };
  });
}
function matchProfileId(name, groupId) {
  const directory = groupPeopleCache.get(groupId) || [];
  const matches = directory.filter(person => normalizedText(person.full_name) === normalizedText(name));
  return matches.length === 1 ? matches[0].id : null;
}
function canGroup(action, group = selectedGroup) { return owner() || Boolean(group && profile?.groups?.some(row => row.id === group.id && row[`can_${action}`])); }
function canGroupModule(action) { return permitted(`groups_${action}`); }
function canSongModule(action) { return permitted(`library_${action}`); }
function canSeeGroups() { return owner() || profile?.all_groups_access === true || ['view','create','edit','delete'].some(action => permitted(`groups_${action}`)) || profile?.groups?.some(group => group.can_view); }
function canSeeAgenda() { return canSeeGroups(); }
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
    const groupKey = normalizedText(group.name);
    const iconFile = groupKey.includes('ebd') || groupKey.includes('escola biblica') ? 'ebd.svg' : groupKey.includes('oracao') ? 'culto-oracao.svg' : groupKey.includes('publico') ? 'culto-publico.svg' : 'grupo-generico.svg';
    const next = group.next_service;
    const nextLabel = next ? `${new Date(`${next.service_date}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })} · ${next.theme || 'Tema a definir'}` : 'Nenhuma escala futura cadastrada';
    tile.innerHTML = `<div class="group-tile-heading"><img class="group-symbol" src="/images/painel/${iconFile}" alt="" aria-hidden="true"><div><h3>${escapeHtml(group.name)}</h3><p>${escapeHtml(weekdayNames[group.service_weekday] || 'Dia a definir')}</p></div></div><div class="group-next-service"><span>PRÓXIMA ESCALA</span><strong>${escapeHtml(nextLabel)}</strong></div><button class="group-open-button" data-open-group type="button">Abrir repertórios <span aria-hidden="true">→</span></button><div class="tile-actions">${canGroupModule('edit') ? `<button class="button-outline" data-group-action="edit" type="button">Editar grupo</button>` : ''}${canGroupModule('delete') ? `<button class="button-quiet" data-group-action="deactivate" type="button">Desativar</button>` : ''}</div>`;
    tile.addEventListener('click', event => { if (!event.target.closest('button')) openGroup(group); });
    tile.querySelector('[data-open-group]').addEventListener('click', () => openGroup(group));
    tile.querySelectorAll('[data-group-action]').forEach(button => button.addEventListener('click', event => { event.stopPropagation(); handleGroupAction(group, button.dataset.groupAction); }));
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
      openGroupForm(group);
    } else if (action === 'deactivate' && window.confirm(`Desativar o grupo ${group.name}? As escalas antigas serão preservadas.`)) {
      await louvorApi('groups', 'PATCH', { id: group.id, is_active: false });
      await loadGroups(); message('Grupo desativado.', true);
    }
  } catch (error) { message(error.message); }
}
function openGroupForm(group = null) {
  $('groupForm').reset(); $('groupId').value = group?.id || ''; $('groupName').value = group?.name || ''; $('groupWeekday').value = String(group?.service_weekday ?? 0);
  $('groupFormTitle').textContent = group ? 'Editar grupo' : 'Novo grupo'; $('groupForm').dataset.dirty = 'false'; $('groupFormWrap').hidden = false;
}
async function saveGroupForm(event) {
  event.preventDefault();
  const id = $('groupId').value; const button = $('groupForm').querySelector('button[type="submit"]'); button.disabled = true;
  try {
    await louvorApi('groups', id ? 'PATCH' : 'POST', { ...(id ? { id } : {}), name: $('groupName').value.trim(), service_weekday: Number($('groupWeekday').value) });
    $('groupFormWrap').hidden = true; await loadGroups(); message(id ? 'Grupo atualizado.' : 'Grupo criado. Configure os acessos na administração de usuários.', true);
  } catch (error) { message(error.message); }
  finally { button.disabled = false; }
}
function monthKey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; }
function fillMonthOptions(services = []) {
  const select = $('serviceMonth');
  const previous = select.value;
  const current = monthKey(new Date());
  $('currentServiceMonth').textContent = new Date(`${current}-01T12:00:00`).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  const keys = [...new Set(services.map(service => String(service.service_date).slice(0, 7)).filter(key => key >= PROJECT_START_MONTH && key < current))].sort().reverse();
  select.innerHTML = '<option value="">Nenhuma escala anterior</option>' + keys.map(key => { const [year, month] = key.split('-').map(Number); const label = new Date(year, month - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }); return `<option value="${key}">${escapeHtml(label)}</option>`; }).join('');
  select.value = keys.includes(previous) ? previous : '';
}
async function openGroup(group) {
  selectedGroup = group;
  $('groupsSection').hidden = true; $('agendaSection').hidden = true; $('servicesSection').hidden = false; $('songsSection').hidden = true;
  $('servicesList').hidden = false;
  $('servicesEmptyState').hidden = true;
  $('serviceDetail').hidden = true;
  $('serviceMonth').value = '';
  $('serviceGroupTitle').textContent = group.name;
  $('serviceGroupKicker').textContent = group.name.toLocaleUpperCase('pt-BR');
  $('newServiceButton').hidden = !canGroup('create', group);
  $('emptyNewServiceButton').hidden = !canGroup('create', group);
  $('serviceEditorWrap').hidden = true;
  try { await loadServices(); } catch (error) { message(error.message); }
}
async function loadServices() {
  const groupId = selectedGroup.id;
  const query = `&group_id=${encodeURIComponent(groupId)}`;
  let result = await louvorApi('services', 'GET', null, query);
  groupServices = result.services || [];
  const expected = selectedGroup.next_service;
  const currentMonth = monthKey(new Date());
  if (expected && String(expected.service_date).startsWith(currentMonth) && !groupServices.some(service => service.id === expected.id)) {
    await new Promise(resolve => window.setTimeout(resolve, 300));
    result = await louvorApi('services', 'GET', null, query);
    groupServices = result.services || [];
    if (!groupServices.some(service => service.id === expected.id)) {
      const recovered = await louvorApi('service', 'GET', null, `&id=${encodeURIComponent(expected.id)}`);
      if (recovered.service) groupServices.push(recovered.service);
    }
  }
  fillMonthOptions(groupServices);
  renderServices(groupServices);
}
function formatServiceDate(date) { return new Date(`${date}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' }); }
function renderServices(allServices) {
  const month = $('serviceMonth').value || monthKey(new Date());
  const isCurrentMonth = month === monthKey(new Date());
  const [year, monthNumber] = month.split('-').map(Number);
  const targetWeekday = Number.isInteger(selectedGroup.service_weekday) ? selectedGroup.service_weekday : 0;
  const lastDay = new Date(year, monthNumber, 0).getDate();
  const existingByDate = new Map(allServices.filter(service => String(service.service_date).startsWith(month)).map(service => [service.service_date, service]));
  const dates = isCurrentMonth
    ? Array.from({ length: lastDay }, (_, index) => index + 1).filter(day => new Date(year, monthNumber - 1, day, 12).getDay() === targetWeekday).map(day => `${year}-${String(monthNumber).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
    : [...existingByDate.keys()].sort();
  $('newServiceButton').hidden = !canGroup('create') || !isCurrentMonth;
  $('emptyNewServiceButton').hidden = !canGroup('create') || !isCurrentMonth;
  $('servicesEmptyState').querySelector('h3').textContent = isCurrentMonth ? 'Nenhuma escala neste mês' : 'Nenhuma escala anterior neste período';
  $('servicesEmptyState').querySelector('p').textContent = isCurrentMonth ? 'Adicione uma escala ou importe o arquivo mensal.' : 'Este grupo ainda não tem escalas salvas neste mês.';
  $('servicesList').replaceChildren(); $('servicesEmptyState').hidden = dates.length > 0;
  const today = localDateKey(new Date());
  const nextScheduled = allServices.filter(service => String(service.service_date) >= today).map(service => String(service.service_date)).sort()[0] || '';
  dates.forEach(date => {
    const service = existingByDate.get(date);
    const card = document.createElement('article'); card.className = 'service-tile';
    const dateLabel = new Date(`${date}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const themeLabel = service?.theme || 'Tema a definir';
    const isPast = date < today;
    const status = isPast ? (service ? ['past', 'REALIZADA'] : ['empty-past', 'SEM ESCALA']) : date === today ? ['today', 'HOJE'] : service && date === nextScheduled ? ['next', 'PRÓXIMA'] : service ? ['scheduled', 'AGENDADA'] : ['prepare', 'A PREPARAR'];
    card.classList.add(`service-${status[0]}`);
    card.innerHTML = `<div class="service-card-top"><span class="service-date">${escapeHtml(formatServiceDate(date))}</span><span class="service-status ${status[0]}">${status[1]}</span></div><h3>Repertório · ${escapeHtml(dateLabel)}</h3><p class="theme">Tema: ${escapeHtml(themeLabel)}</p><p class="service-card-hint">${service ? 'Toque para consultar a escala' : (isPast ? 'Não foi registrada uma escala para esta data' : canGroup('create') ? 'Toque para preparar esta escala' : 'Escala ainda não publicada')}</p>`;
    card.addEventListener('click', () => service ? openService(service.id) : (isCurrentMonth && canGroup('create') ? openServiceEditor(null, { service_date: date }) : null));
    $('servicesList').append(card);
  });
}
function defaultServiceDate(group) {
  const target = Number.isInteger(group.service_weekday) ? group.service_weekday : (normalizedText(group.name).includes('oracao') ? 4 : 0);
  const date = new Date(); date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + ((target - date.getDay() + 7) % 7));
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function localDateKey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
async function openService(id) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await louvorApi('service', 'GET', null, `&id=${encodeURIComponent(id)}`);
      if (!result?.service) throw Object.assign(new Error('O repertório não veio completo do servidor.'), { status: 502 });
      renderServiceDetail(result.service);
      return;
    } catch (error) {
      const retryable = !error.status || error.status >= 500;
      if (attempt === 0 && retryable) {
        await new Promise(resolve => window.setTimeout(resolve, 350));
        continue;
      }
      message(error.message);
      return;
    }
  }
}
function agendaMonthText(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(year, monthNumber - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
}
async function loadAgenda() {
  $('agendaMonthLabel').textContent = agendaMonthText(agendaMonth);
  $('agendaList').hidden = false;
  $('agendaList').innerHTML = '<div class="agenda-loading">Carregando suas escalas…</div>';
  $('agendaEmptyState').hidden = true;
  try {
    const result = await louvorApi('agenda', 'GET', null, `&month=${encodeURIComponent(agendaMonth)}`);
    agendaEvents = result.events || [];
    $('agendaEmptyState').querySelector('h3').textContent = 'Nenhuma escala encontrada neste mês';
    $('agendaEmptyState').querySelector('p').textContent = 'Quando seu nome estiver vinculado a uma escala futura, ela aparecerá aqui. Se você deveria estar escalado, peça a um responsável para conferir o vínculo da sua conta na escala.';
    const groups = ministryGroups;
    const filter = $('agendaGroupFilter');
    const previous = filter.value;
    filter.innerHTML = '<option value="">Todos os meus grupos</option>' + groups.map(group => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`).join('');
    filter.value = groups.some(group => group.id === previous) ? previous : '';
    renderAgenda();
  } catch (error) {
    $('agendaList').replaceChildren(); $('agendaList').hidden = true; $('agendaEmptyState').hidden = false;
    $('agendaEmptyState').querySelector('h3').textContent = 'Não foi possível carregar sua agenda';
    $('agendaEmptyState').querySelector('p').textContent = error.message;
  }
  $('agendaPreviousMonth').disabled = agendaMonth <= monthKey(new Date());
}
function renderAgenda() {
  const selectedGroupId = $('agendaGroupFilter').value;
  const events = agendaEvents.filter(event => !selectedGroupId || event.group.id === selectedGroupId);
  $('agendaList').innerHTML = events.map(event => {
    const date = new Date(`${event.service_date}T12:00:00`);
    const isToday = event.service_date === localDateKey(new Date());
    const day = date.toLocaleDateString('pt-BR', { day: '2-digit' });
    const weekday = date.toLocaleDateString('pt-BR', { weekday: 'long' });
    const month = date.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '');
    return `<article class="agenda-event ${isToday ? 'is-today' : ''}"><div class="agenda-date"><strong>${day}</strong><span>${escapeHtml(month)}</span></div><div class="agenda-event-main"><span class="section-kicker">${escapeHtml(event.group.name)}</span><h3>${escapeHtml(weekday)}${isToday ? ' · Hoje' : ''}</h3><p>${escapeHtml(event.theme || 'Tema a definir')}</p></div><button class="button-outline" data-agenda-service="${escapeHtml(event.id)}" data-agenda-group="${escapeHtml(event.group_id)}" type="button">Ver repertório <span aria-hidden="true">→</span></button></article>`;
  }).join('');
  $('agendaEmptyState').hidden = events.length > 0;
  $('agendaList').hidden = events.length === 0;
  $('agendaList').querySelectorAll('[data-agenda-service]').forEach(button => button.addEventListener('click', () => openAgendaService(button.dataset.agendaService, button.dataset.agendaGroup)));
}
async function openAgendaService(serviceId, groupId) {
  const group = ministryGroups.find(item => item.id === groupId);
  if (!group) return message('Este grupo não está mais disponível para sua conta.');
  closeMobileMenu();
  await openGroup(group);
  await openService(serviceId);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function renderServiceDetail(service) {
  currentService = service;
  const singers = service.people.filter(person => person.role === 'singer').map(person => `<li>${escapeHtml(person.name)}</li>`).join('') || '<li>A definir</li>';
  const musicians = service.people.filter(person => person.role === 'musician').map(person => `<li>${escapeHtml(person.name)}</li>`).join('') || '<li>A definir</li>';
  const songs = service.songs.map((song, index) => {
    const youtube = safeExternalUrl(song.youtube_url_snapshot); const chart = safeExternalUrl(song.chart_url_snapshot);
    return `<article class="service-detail-song"><div class="song-detail-title"><span class="song-number">${index + 1}</span><div><h4>${escapeHtml(song.title_snapshot)}</h4>${song.artist_snapshot ? `<p>${escapeHtml(song.artist_snapshot)}</p>` : ''}</div></div>${song.soloist ? `<div class="soloist-highlight"><span aria-hidden="true">🎤</span><div><small>SOLISTA(S)</small><strong>${escapeHtml(song.soloist)}</strong></div></div>` : '<p class="no-soloist">Solista a definir</p>'}<div class="song-detail-meta"><span class="song-key ${song.male_key_snapshot ? '' : 'pending'}">Tom masculino <strong>${escapeHtml(song.male_key_snapshot || 'A definir')}</strong></span><span class="song-key ${song.female_key_snapshot ? '' : 'pending'}">Tom feminino <strong>${escapeHtml(song.female_key_snapshot || 'A definir')}</strong></span></div><div class="song-detail-links">${youtube ? `<a class="song-resource-link" href="${escapeHtml(youtube)}" target="_blank" rel="noopener">▶ YouTube</a>` : '<span class="song-resource-pending">YouTube pendente</span>'}${chart ? `<a class="song-resource-link" href="${escapeHtml(chart)}" target="_blank" rel="noopener">♫ Cifra</a>` : '<span class="song-resource-pending">Cifra pendente</span>'}</div></article>`;
  }).join('') || '<p class="empty-repertoire">Nenhuma música adicionada.</p>';
  const nextDate = groupServices.filter(row => String(row.service_date) >= localDateKey(new Date())).map(row => String(row.service_date)).sort()[0];
  const dateState = service.service_date < localDateKey(new Date()) ? ['past', 'REALIZADA'] : service.service_date === localDateKey(new Date()) ? ['today', 'HOJE'] : service.service_date === nextDate ? ['next', 'PRÓXIMA'] : ['scheduled', 'AGENDADA'];
  const monthLabel = new Date(`${service.service_date}T12:00:00`).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  $('serviceDetail').innerHTML = `<div class="service-detail-header"><div class="service-breadcrumb"><button class="text-back-button" id="serviceBackButton" type="button">← Voltar às escalas</button><span>› ${escapeHtml(selectedGroup.name)}</span><span>› ${escapeHtml(monthLabel)}</span></div><div class="service-detail-heading"><div><span class="section-kicker">${escapeHtml(selectedGroup.name.toLocaleUpperCase('pt-BR'))}</span><h3>${escapeHtml(formatServiceDate(service.service_date))}</h3><p class="service-detail-theme">Tema: <strong>${escapeHtml(service.theme || 'A definir')}</strong></p></div><div class="service-detail-actions"><span class="service-status ${dateState[0]}">${dateState[1]}</span><button class="button-outline" id="copyServiceButton" type="button">Copiar repertório</button><button class="button-outline" id="printServiceButton" type="button">Imprimir / PDF</button>${canGroup('edit', selectedGroup) ? `<button class="button-primary" id="editServiceButton" type="button">Editar escala</button>` : ''}</div></div></div><div class="service-team-grid"><section class="service-team-card singers-card"><span>👥 CANTORES</span><ul>${singers}</ul></section><section class="service-team-card musicians-card"><span>🎸 MÚSICOS</span><ul>${musicians}</ul></section></div><div class="service-repertoire-heading"><div><span class="section-kicker">REPERTÓRIO</span><h3>${service.songs.length} ${service.songs.length === 1 ? 'música' : 'músicas'}</h3></div><p>Solistas, tons e referências</p></div><div class="service-detail-songs">${songs}</div><details class="snapshot-details"><summary>Histórico de alterações (${service.snapshots.length})</summary><ol class="snapshots-list">${service.snapshots.map(row => `<li>${escapeHtml(formatDate(row.created_at))}</li>`).join('') || '<li>Nenhuma alteração anterior.</li>'}</ol></details><div class="service-detail-footer"><button class="button-quiet" id="serviceBackBottomButton" type="button">← Voltar às escalas</button></div>`;
  $('servicesList').hidden = true; $('servicesEmptyState').hidden = true; $('serviceDetail').hidden = false;
  $('serviceBackButton').addEventListener('click', () => { $('serviceDetail').hidden = true; $('servicesList').hidden = false; loadServices().catch(error => message(error.message)); });
  $('serviceBackBottomButton').addEventListener('click', () => { $('serviceDetail').hidden = true; $('servicesList').hidden = false; loadServices().catch(error => message(error.message)); window.scrollTo({ top: 0, behavior: 'smooth' }); });
  $('editServiceButton')?.addEventListener('click', () => openServiceEditor(service));
  $('copyServiceButton').addEventListener('click', () => copyServiceRepertoire(service).catch(error => message(error.message)));
  $('printServiceButton').addEventListener('click', () => window.print());
}
async function copyServiceRepertoire(service) {
  const lines = ['PRIMEIRA IGREJA PRESBITERIANA NA ENSEADA', 'MINISTÉRIO DE LOUVOR', `ESCALA · ${selectedGroup.name.toLocaleUpperCase('pt-BR')}`, formatServiceDate(service.service_date), `Tema: ${service.theme || 'A definir'}`, '', 'CANTORES', ...service.people.filter(person => person.role === 'singer').map(person => `• ${person.name}`), '', 'MÚSICOS', ...service.people.filter(person => person.role === 'musician').map(person => `• ${person.name}`), '', 'REPERTÓRIO'];
  service.songs.forEach((song, index) => { lines.push('', `${index + 1}. ${song.title_snapshot}${song.artist_snapshot ? ` — ${song.artist_snapshot}` : ''}`); if (song.soloist) lines.push(`Solista(s): ${song.soloist}`); if (song.male_key_snapshot) lines.push(`Tom masculino: ${song.male_key_snapshot}`); if (song.female_key_snapshot) lines.push(`Tom feminino: ${song.female_key_snapshot}`); if (song.youtube_url_snapshot) lines.push(`YouTube: ${song.youtube_url_snapshot}`); if (song.chart_url_snapshot) lines.push(`Cifra: ${song.chart_url_snapshot}`); });
  const text = lines.join('\n');
  try { await navigator.clipboard.writeText(text); }
  catch {
    const helper = document.createElement('textarea'); helper.value = text; helper.setAttribute('readonly', ''); helper.style.position = 'fixed'; helper.style.opacity = '0'; document.body.append(helper); helper.select();
    const copied = document.execCommand('copy'); helper.remove();
    if (!copied) throw new Error('Não foi possível copiar automaticamente. Tente imprimir ou selecionar o repertório.');
  }
  message('Repertório copiado. Você já pode colá-lo na conversa do grupo.', true);
}
function renderServiceSongRows(songs = []) {
  $('serviceSongRows').innerHTML = songs.map((song, index) => `<div class="service-song-editor" data-song-row><div class="service-song-editor-head"><strong>Música ${index + 1}</strong><div class="tile-actions">${song.song_id ? '' : '<button class="button-outline" type="button" data-register-song>Adicionar à biblioteca</button>'}<button class="button-quiet" type="button" data-remove-song>Remover</button></div></div><input type="hidden" data-field="song_id" value="${escapeHtml(song.song_id || '')}"><label class="soloist-editor-field"><span><b>🎤 Solista(s) desta música</b><small>Informe uma ou duas pessoas; pode separar os nomes por “e” ou vírgula.</small></span><input data-field="soloist" maxlength="200" placeholder="Ex.: Corina e André" value="${escapeHtml(song.soloist || '')}"></label><div class="service-song-editor-grid"><label>Título<input data-field="title_snapshot" maxlength="200" value="${escapeHtml(song.title_snapshot || '')}" required></label><label>Artista / compositor<input data-field="artist_snapshot" value="${escapeHtml(song.artist_snapshot || '')}"></label><label>Tom masculino<input data-field="male_key_snapshot" value="${escapeHtml(song.male_key_snapshot || '')}"></label><label>Tom feminino<input data-field="female_key_snapshot" value="${escapeHtml(song.female_key_snapshot || '')}"></label><label>YouTube<input data-field="youtube_url_snapshot" type="url" value="${escapeHtml(song.youtube_url_snapshot || '')}"></label><label>Cifra<input data-field="chart_url_snapshot" type="url" value="${escapeHtml(song.chart_url_snapshot || '')}"></label></div></div>`).join('');
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
  servicePersonSelections.singer.clear(); servicePersonSelections.musician.clear();
  (service?.people || []).filter(row => row.profile_id).forEach(row => servicePersonSelections[row.role === 'musician' ? 'musician' : 'singer'].set(normalizedText(row.name), row.profile_id));
  $('serviceId').value = service?.id || '';
  $('serviceDate').value = service?.service_date || draft?.service_date || defaultServiceDate(selectedGroup);
  $('serviceTheme').value = service?.theme || draft?.theme || '';
  $('serviceSingers').value = service?.people.filter(row => row.role === 'singer').map(row => row.name).join('\n') || (draft?.singers || []).join('\n');
  $('serviceMusicians').value = service?.people.filter(row => row.role === 'musician').map(row => row.name).join('\n') || (draft?.musicians || []).join('\n');
  $('serviceForm').dataset.dirty = 'false';
  renderServiceSongRows(service?.songs || draft?.songs || []);
  $('serviceEditorTitle').textContent = service ? 'Editar escala' : 'Nova escala';
  $('serviceDetail').hidden = true; $('servicesList').hidden = false; $('serviceEditorWrap').hidden = false;
  await Promise.all([loadSongs(), loadGroupPeople(selectedGroup.id)]);
  renderServicePersonLinks('singer'); renderServicePersonLinks('musician');
  fillSongPicker();
  $('serviceEditorWrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function fillSongPicker() { $('songCatalogPicker').innerHTML = '<option value="">Selecione uma música</option>' + songCatalog.map(song => `<option value="${escapeHtml(song.id)}">${escapeHtml(song.title)}${song.artist ? ` — ${escapeHtml(song.artist)}` : ''}</option>`).join(''); }
async function saveServiceForm(event) {
  event.preventDefault();
  const id = $('serviceId').value;
  const songs = readServiceSongRows();
  if (songs.length > 8) return message('Cada escala pode ter no máximo oito músicas.');
  const body = { id, group_id: selectedGroup.id, service_date: $('serviceDate').value, theme: $('serviceTheme').value.trim(), people: [...servicePersonRows('singer', $('serviceSingers').value), ...servicePersonRows('musician', $('serviceMusicians').value)], songs };
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
  $('emptyNewSongButton').hidden = !canSongModule('create');
  const oldTheme = $('songThemeFilter').value;
  const themes = [...new Set(songCatalog.flatMap(song => String(song.themes || '').split(/[,;]/).map(theme => theme.trim()).filter(Boolean)))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  $('songThemeFilter').innerHTML = '<option value="">Todos os temas</option>' + themes.map(theme => `<option value="${escapeHtml(theme)}">${escapeHtml(theme)}</option>`).join('');
  $('songThemeFilter').value = themes.includes(oldTheme) ? oldTheme : '';
  const query = normalizedText($('songSearch').value);
  const statusFilter = $('songStatusFilter').value;
  const themeFilter = $('songThemeFilter').value;
  const visible = songCatalog.filter(song => {
    const missing = songMissingFields(song).length > 0;
    return (!query || normalizedText(`${song.title} ${song.artist} ${song.composer} ${song.themes}`).includes(query)) && (!themeFilter || String(song.themes || '').split(/[,;]/).some(theme => theme.trim() === themeFilter)) && (statusFilter === 'all' || (statusFilter === 'pending' ? missing : !missing));
  });
  $('songCount').textContent = `${visible.length} de ${songCatalog.length} ${songCatalog.length === 1 ? 'música' : 'músicas'}`;
  $('songsEmptyState').hidden = visible.length > 0;
  $('songsEmptyState').querySelector('h3').textContent = songCatalog.length ? 'Nenhuma música encontrada' : 'A biblioteca começa aqui';
  $('songsEmptyState').querySelector('p').textContent = songCatalog.length ? 'Ajuste a busca ou os filtros para encontrar uma música.' : 'Cadastre suas músicas para reutilizá-las nas escalas.';
  visible.forEach(song => {
    const card = document.createElement('article'); card.className = 'song-catalog-card';
    const youtube = safeExternalUrl(song.youtube_url); const chart = safeExternalUrl(song.chart_url);
    const missing = songMissingFields(song);
    const themesMarkup = String(song.themes || '').split(/[,;]/).map(theme => theme.trim()).filter(Boolean).map(theme => `<span class="song-theme-chip">${escapeHtml(theme)}</span>`).join('');
    card.classList.toggle('song-incomplete', missing.length > 0);
    const artistLabel = song.is_hymn ? [song.artist, song.composer ? `Compositor: ${song.composer}` : ''].filter(Boolean).join(' · ') : `${song.artist || 'Artista a definir'}${song.composer ? ` · Compositor: ${song.composer}` : ''}`;
    const keyMarkup = (label, value) => `<div class="song-key-value ${value ? '' : song.is_hymn ? 'optional' : 'pending'}"><small>${label}</small><strong>${escapeHtml(value || (song.is_hymn ? 'Opcional para hinos' : 'A definir'))}</strong></div>`;
    card.innerHTML = `<div class="song-card-heading"><div><h3>${escapeHtml(song.title)}</h3><p>${escapeHtml(artistLabel || (song.is_hymn ? 'Hino' : 'Artista a definir'))}</p></div><div class="song-card-badges">${song.is_hymn ? '<span class="song-type-tag">HINO</span>' : ''}<span class="song-completeness ${missing.length ? 'pending' : 'complete'}">${missing.length ? 'Pendente' : 'Completa'}</span></div></div><div class="song-theme-list">${themesMarkup || '<span class="muted small">Sem tema</span>'}</div><div class="song-key-grid">${keyMarkup('Tom masculino', song.male_key)}${keyMarkup('Tom feminino', song.female_key)}</div><div class="song-catalog-resources">${youtube ? `<a class="song-resource-link" href="${escapeHtml(youtube)}" target="_blank" rel="noopener">▶ YouTube</a>` : '<span class="song-resource-pending">YouTube pendente</span>'}${chart ? `<a class="song-resource-link" href="${escapeHtml(chart)}" target="_blank" rel="noopener">♫ Cifra</a>` : `<span class="song-resource-${song.is_hymn ? 'optional' : 'pending'}">Cifra ${song.is_hymn ? 'opcional para hinos' : 'pendente'}</span>`}</div>${missing.length ? `<p class="song-missing-hint">Faltam: ${escapeHtml(missing.join(', '))}</p>` : ''}<div class="tile-actions">${canSongModule('edit') ? '<button class="button-outline" data-song-action="edit" type="button">Editar dados</button>' : ''}${canSongModule('delete') ? '<button class="button-quiet" data-song-action="delete" type="button">Excluir</button>' : ''}</div>`;
    card.querySelector('[data-song-action="edit"]')?.addEventListener('click', () => openSongForm(song));
    card.querySelector('[data-song-action="delete"]')?.addEventListener('click', async () => { if (!window.confirm(`Excluir ${song.title} da biblioteca? Escalas antigas mantêm seus dados.`)) return; try { await louvorApi('songs', 'DELETE', { id: song.id }); await loadSongs($('songSearch').value.trim()); message('Música excluída da biblioteca.', true); } catch (error) { message(error.message); } });
    list.append(card);
  });
}
function songMissingFields(song) {
  if (song.is_hymn) return [['Tema', song.themes], ['YouTube', song.youtube_url]].filter(([, value]) => !String(value || '').trim()).map(([label]) => label);
  return [['Artista / ministério', song.artist], ['Compositor', song.composer], ['Tema', song.themes], ['Tom masculino', song.male_key], ['Tom feminino', song.female_key], ['YouTube', song.youtube_url], ['Cifra', song.chart_url]].filter(([, value]) => !String(value || '').trim()).map(([label]) => label);
}
function syncHymnArtistField() {
  const artist = $('songArtist');
  if ($('songIsHymn').checked) {
    if (artist.dataset.hymnAutofilled !== 'true') artist.dataset.hymnPrevious = artist.value.trim().toLocaleLowerCase('pt-BR') === 'hinário' ? '' : artist.value;
    artist.value = 'Hinário';
    artist.disabled = true;
    artist.dataset.hymnAutofilled = 'true';
  } else {
    artist.disabled = false;
    if (artist.dataset.hymnAutofilled === 'true') artist.value = artist.dataset.hymnPrevious || '';
    artist.dataset.hymnAutofilled = 'false';
    delete artist.dataset.hymnPrevious;
  }
}
function openSongForm(song = null, fromService = false, serviceRowIndex = null) {
  returnToServiceEditor = fromService;
  returnToServiceRow = serviceRowIndex;
  $('songId').value = song?.id || ''; $('songTitle').value = song?.title || ''; $('songArtist').value = song?.artist || ''; $('songComposer').value = song?.composer || '';
  $('songIsHymn').checked = song?.is_hymn === true;
  $('songThemes').value = song?.themes || ''; $('songMaleKey').value = song?.male_key || ''; $('songFemaleKey').value = song?.female_key || '';
  $('songYoutube').value = song?.youtube_url || ''; $('songChart').value = song?.chart_url || '';
  $('songArtist').dataset.hymnAutofilled = 'false'; delete $('songArtist').dataset.hymnPrevious;
  syncHymnArtistField();
  $('songForm').dataset.dirty = 'false';
  $('songFormTitle').textContent = song ? 'Editar música' : 'Nova música'; $('songFormWrap').hidden = false;
  if (fromService) { $('servicesSection').hidden = true; $('songsSection').hidden = false; }
  $('songFormWrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function closeSongEditor() {
  closeEditor('songFormWrap', 'songForm');
  if (!$('songFormWrap').hidden) return;
  if (returnToServiceEditor) { $('songsSection').hidden = true; $('servicesSection').hidden = false; $('serviceEditorWrap').hidden = false; }
  returnToServiceEditor = false; returnToServiceRow = null;
}
async function saveSongForm(event) {
  event.preventDefault(); const id = $('songId').value;
  const isHymn = $('songIsHymn').checked;
  const body = { id, title: $('songTitle').value.trim(), is_hymn: isHymn, artist: isHymn ? 'Hinário' : $('songArtist').value.trim(), composer: $('songComposer').value.trim(), themes: $('songThemes').value.trim(), male_key: $('songMaleKey').value.trim(), female_key: $('songFemaleKey').value.trim(), youtube_url: $('songYoutube').value.trim(), chart_url: $('songChart').value.trim() };
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
function importGroupForDay(day) {
  const active = ministryGroups.filter(group => group.is_active && (owner() || canGroup('create', group)));
  const key = day === 'QUINTA' ? 'quinta' : 'domingo';
  const preferred = active.filter(group => {
    const name = normalizedText(group.name);
    if (day === 'QUINTA') return name.includes('oracao') || name.includes('quinta') || group.service_weekday === 4;
    return name === 'ebd' || name.includes('escola biblica') || name.includes('ebd');
  });
  const unique = [...new Map(preferred.map(group => [group.id, group])).values()];
  if (unique.length === 1) return unique[0];
  const expected = day === 'QUINTA' ? 'Culto de Oração (quinta-feira)' : 'EBD (domingo)';
  if (unique.length > 1) throw new Error(`Encontrei mais de um grupo possível para ${day.toLocaleLowerCase('pt-BR')}. Renomeie os grupos para identificar claramente ${expected}.`);
  throw new Error(`Não encontrei um grupo com permissão de criação para ${day.toLocaleLowerCase('pt-BR')}. Confira se existe ${expected} e se você pode criar escalas nele.`);
}
function parseTabularServiceBlocks(lines) {
  const markers = [];
  lines.forEach((line, index) => {
    const match = line.trim().match(/^(QUINTA|DOMINGO)\b(?:\s+(\d{1,2}\/\d{1,2}\/20\d{2}))?\s*$/i);
    if (match) markers.push({ index, day: match[1].toLocaleUpperCase('pt-BR'), inlineDate: match[2] || '' });
  });
  if (!markers.length) return null;
  const drafts = [];
  for (let blockIndex = 0; blockIndex < markers.length; blockIndex++) {
    const marker = markers[blockIndex];
    const end = markers[blockIndex + 1]?.index ?? lines.length;
    const block = lines.slice(marker.index, end);
    const blockText = [marker.inlineDate, ...block].join('\n');
    const dateMatch = /\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/.exec(blockText);
    if (!dateMatch) throw new Error(`Não encontrei a data do bloco ${marker.day.toLocaleLowerCase('pt-BR')}. Inclua a data como DD/MM/AAAA.`);
    const [, dayText, monthText, yearText] = dateMatch;
    const dayNumber = Number(dayText), monthNumber = Number(monthText), year = Number(yearText);
    const date = new Date(year, monthNumber - 1, dayNumber, 12);
    if (date.getFullYear() !== year || date.getMonth() !== monthNumber - 1 || date.getDate() !== dayNumber) throw new Error(`A data ${dateMatch[0]} não é válida.`);
    const expectedWeekday = marker.day === 'QUINTA' ? 4 : 0;
    if (date.getDay() !== expectedWeekday) throw new Error(`${dateMatch[0]} está marcado como ${marker.day.toLocaleLowerCase('pt-BR')}, mas cai em ${weekdayNames[date.getDay()]}. Confira o arquivo.`);

    const singers = [], musicians = [], songs = [];
    for (const original of block) {
      const line = original.trim();
      if (!line || /^(QUINTA|DOMINGO)\b/i.test(line) || /\b\d{1,2}\/\d{1,2}\/20\d{2}\b/.test(line)) continue;
      const heading = normalizedText(line).replace(/:$/, '');
      if (['cantores','musicos','musicas','louvores','escala do louvor do mes referente as quintas e domingos na ebd'].includes(heading)) continue;
      let cells;
      if (original.includes('\t')) {
        cells = original.split('\t').map(value => value.trim());
        if (cells.some(cell => ['cantores','musicos','musicas','louvores'].includes(normalizedText(cell)))) continue;
      } else {
        const row = line.match(/^\s*\d+\s+(.+?)\s{2,}(.+?)\s{2,}(.+?)\s*$/);
        if (!row) continue;
        cells = ['', row[1].trim(), row[2].trim(), row[3].trim()];
      }
      if (/^\d+\s*[.)-]?$/.test(cells[0] || '')) cells.shift();
      else if (cells.length >= 4 && !cells[0]) cells.shift();
      const singer = cells[0] || '';
      const musician = cells[1] || '';
      const songCell = cells.slice(2).filter(Boolean).join(' ').trim();
      if (singer && !singers.includes(singer)) singers.push(singer);
      if (musician && !musicians.includes(musician)) musicians.push(musician);
      if (songCell) {
        const artistMatch = songCell.match(/\(([^)]+)\)\s*$/);
        const artist = artistMatch && /minist[eé]rio|banda|praise|fernandinho|morada|vineyard|avivah/i.test(artistMatch[1]) ? artistMatch[1].trim() : '';
        const title = artist ? songCell.slice(0, artistMatch.index).trim() : songCell;
        if (title) songs.push({ song_id: '', title_snapshot: title, artist_snapshot: artist, soloist: '', male_key_snapshot: '', female_key_snapshot: '', youtube_url_snapshot: '', chart_url_snapshot: '' });
      }
    }
    const group = importGroupForDay(marker.day);
    const iso = `${year}-${String(monthNumber).padStart(2, '0')}-${String(dayNumber).padStart(2, '0')}`;
    drafts.push({ group_id: group.id, service_date: iso, theme: '', singers, musicians, songs });
  }
  if (drafts.some(draft => draft.songs.length > 8)) throw new Error('Uma escala tem mais de oito músicas. Reduza o repertório antes de salvar.');
  return drafts;
}
function parseRepertoireText(text) {
  const monthNames = ['janeiro','fevereiro','marco','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
  const normalized = normalizedText(text);
  const lines = text.split(/\r?\n/);
  const tabularDrafts = parseTabularServiceBlocks(lines);
  if (tabularDrafts) return tabularDrafts;
  const headerText = normalizedText(lines.slice(0, 8).join(' '));
  const monthYear = new RegExp(`\\b(${monthNames.join('|')})\\b(?:\\s+de)?\\s+(20\\d{2})\\b`).exec(headerText);
  if (!monthYear) throw new Error('Não encontrei mês e ano no cabeçalho. Inclua algo como “Escala de Novembro - 2026” nas primeiras linhas.');
  const month = monthNames.indexOf(monthYear[1]);
  const year = Number(monthYear[2]);
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
async function renderImportPreview() {
  importDraft = parseRepertoireText($('repertoireText').value);
  const groupIdsForPeople = [...new Set(importDraft.map(draft => draft.group_id))];
  await Promise.all(groupIdsForPeople.map(groupId => loadGroupPeople(groupId)));
  const months = [...new Set(importDraft.map(draft => draft.service_date.slice(0, 7)))];
  const monthLabels = months.map(key => { const [year, month] = key.split('-').map(Number); return new Date(year, month - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }); });
  const monthLabel = monthLabels.join(' · ');
  const groupLabels = [...new Set(importDraft.map(draft => ministryGroups.find(group => group.id === draft.group_id)?.name || 'Grupo selecionado'))];
  const totalSongs = importDraft.reduce((total, draft) => total + draft.songs.length, 0);
  const unlinked = importDraft.reduce((count, draft) => count + [...draft.singers, ...draft.musicians].filter(name => !matchProfileId(name, draft.group_id)).length, 0);
  const duplicateDates = importDraft.filter((draft, index, all) => all.findIndex(row => row.group_id === draft.group_id && row.service_date === draft.service_date) !== index);
  const warning = duplicateDates.length ? `<p class="import-warning">Há datas repetidas no mesmo grupo. Revise o arquivo antes de salvar.</p>` : '';
  const linkNotice = unlinked ? `<p class="import-link-warning">${unlinked} nome(s) não foram vinculados automaticamente a uma conta. A escala será importada normalmente; edite-a depois para associar esses nomes se forem integrantes cadastrados.</p>` : `<p class="import-link-success">Todos os nomes de cantores e músicos foram associados automaticamente às contas correspondentes.</p>`;
  $('importPreview').innerHTML = `<div class="import-preview-summary"><span class="section-kicker">ETAPA 2 DE 2 · REVISE ANTES DE SALVAR</span><h4>${escapeHtml(groupLabels.join(' + '))} · ${escapeHtml(monthLabel)}</h4><p>${importDraft.length} escalas · ${totalSongs} músicas · datas e grupos identificados pelo cabeçalho de cada bloco</p>${warning}${linkNotice}</div>${importDraft.map(draft => { const groupName = ministryGroups.find(group => group.id === draft.group_id)?.name || 'Grupo'; return `<article class="import-preview-card"><h4>${escapeHtml(groupName)} · ${escapeHtml(formatServiceDate(draft.service_date))}${draft.theme ? ` · ${escapeHtml(draft.theme)}` : ''}</h4><p><strong>Cantores:</strong> ${draft.singers.map(escapeHtml).join(', ') || 'não informados'} · <strong>Músicos:</strong> ${draft.musicians.map(escapeHtml).join(', ') || 'não informados'}</p><p><strong>Músicas (${draft.songs.length}):</strong> ${draft.songs.map(song => escapeHtml(song.title_snapshot)).join(' · ') || 'não informadas'}</p></article>`; }).join('')}`;
  $('importPreview').hidden = false; $('saveImportButton').disabled = duplicateDates.length > 0;
  if (duplicateDates.length) message('A prévia encontrou datas repetidas para o mesmo grupo. Corrija o arquivo antes de salvar.');
}
async function saveImportDraft() {
  if (!importDraft.length) return;
  $('saveImportButton').disabled = true;
  try {
    await loadSongs();
    const existingByKey = new Map();
    const groupIds = [...new Set(importDraft.map(draft => draft.group_id))];
    for (const groupId of groupIds) {
      await loadGroupPeople(groupId);
      const existing = await louvorApi('services', 'GET', null, `&group_id=${encodeURIComponent(groupId)}`);
      (existing.services || []).forEach(service => existingByKey.set(`${groupId}:${service.service_date}`, service));
    }
    const hasExisting = importDraft.some(draft => existingByKey.has(`${draft.group_id}:${draft.service_date}`));
    if (hasExisting && !window.confirm('Há datas que já possuem escala. Deseja substituir os dados dessas datas? O sistema guardará um histórico da versão anterior.')) return;
    for (const draft of importDraft) {
      draft.songs = draft.songs.map(song => {
        const found = songCatalog.find(item => normalizedText(item.title) === normalizedText(song.title_snapshot));
        return found ? { ...song, song_id: found.id, artist_snapshot: song.artist_snapshot || found.artist, male_key_snapshot: found.male_key, female_key_snapshot: found.female_key, youtube_url_snapshot: found.youtube_url, chart_url_snapshot: found.chart_url } : song;
      });
      const old = existingByKey.get(`${draft.group_id}:${draft.service_date}`);
      await louvorApi('service', old ? 'PATCH' : 'POST', { ...draft, ...(old ? { id: old.id } : {}), people: [...draft.singers.map(name => ({ role: 'singer', name, profile_id: matchProfileId(name, draft.group_id) })), ...draft.musicians.map(name => ({ role: 'musician', name, profile_id: matchProfileId(name, draft.group_id) }))] });
    }
    const importedCount = importDraft.length;
    $('importWrap').hidden = true; $('repertoireText').value = ''; $('repertoireFile').value = ''; $('importPreview').hidden = true; await loadGroups(); message(`${importedCount} escalas importadas. Complete os links, tons e músicas pendentes.`, true); importDraft = [];
  } catch (error) { message(error.message); }
  finally { $('saveImportButton').disabled = false; }
}
function activatePanelSection(id) {
  const sections = ['groupsSection','agendaSection','servicesSection','songsSection','userAdminSection'];
  sections.forEach(section => {
    if (section === 'userAdminSection' && !canSeeUsers()) $(section).hidden = true;
    else if (section === 'agendaSection' && !canSeeAgenda()) $(section).hidden = true;
    else $(section).hidden = section !== id;
  });
  document.querySelectorAll('.sidebar .nav-link').forEach(link => link.classList.toggle('active', link.getAttribute('href') === `#${id}`));
  if (id === 'agendaSection') loadAgenda();
  if (id === 'songsSection') loadSongs($('songSearch').value.trim()).catch(error => message(error.message));
  if (id === 'userAdminSection') loadUsers().catch(error => message(error.message));
}
function setupDashboard() {
  if (dashboardInitialized) return;
  dashboardInitialized = true;
  setupModalEditors();
  $('itemVisibility').addEventListener('change', () => {
    $('groupPicker').hidden = $('itemVisibility').value !== 'groups';
    if (!$('groupPicker').hidden) renderGroups();
  });
  $('newItemButton').addEventListener('click', () => openItem());
  $('emptyNewItemButton').addEventListener('click', () => openItem());
  $('cancelItemButton').addEventListener('click', () => closeEditor('itemFormWrap', 'itemForm'));
  $('cancelItemButtonBottom').addEventListener('click', () => closeEditor('itemFormWrap', 'itemForm'));
  $('itemForm').addEventListener('submit', saveItem);
  $('itemsList').addEventListener('click', handleItemAction);
  $('searchItems').addEventListener('input', renderItems);
  $('filterVisibility').addEventListener('change', renderItems);
  $('saveNotesButton').addEventListener('click', saveGeneralNotes);
  $('usersNavLink').hidden = !canSeeUsers();
  $('groupsNavLink').hidden = !canSeeGroups();
  $('agendaNavLink').hidden = !canSeeAgenda();
  $('songsNavLink').hidden = !canSeeSongs();
  $('mobileMenuButton').addEventListener('click', () => document.body.classList.contains('mobile-menu-open') ? closeMobileMenu() : openMobileMenu());
  $('mobileMenuClose').addEventListener('click', closeMobileMenu);
  $('mobileMenuBackdrop').addEventListener('click', closeMobileMenu);
  document.addEventListener('keydown', event => {
    const open = [...document.querySelectorAll('.editor-card')].reverse().find(editor => !editor.hidden && editor.closest('[hidden]') === null);
    if (event.key === 'Escape') { closeMobileMenu(); if (open?.id === 'songFormWrap') closeSongEditor(); else if (open) closeEditor(open.id, open.querySelector('form')?.id || ''); }
    if (event.key === 'Tab' && open) {
      const focusable = [...open.querySelectorAll('button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),a[href]')].filter(element => element.getClientRects().length);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (first && event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (last && !event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  $('usersNavLink').addEventListener('click', event => { event.preventDefault(); if (canSeeUsers()) activatePanelSection('userAdminSection'); });
  $('newUserButton').addEventListener('click', () => openUserForm());
  $('cancelUserButton').addEventListener('click', () => closeEditor('userFormWrap', 'userForm'));
  $('cancelUserButtonBottom').addEventListener('click', () => closeEditor('userFormWrap', 'userForm'));
  $('userForm').addEventListener('submit', saveUser);
  $('usersList').addEventListener('click', handleUserAction);
  $('copyTemporaryPassword').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('temporaryPasswordText').textContent); message('Senha copiada. Entregue-a diretamente ao usuário.', true); } catch { message('Não foi possível copiar automaticamente. Selecione e copie a senha.'); } });
  $('groupsNavLink').addEventListener('click', event => { event.preventDefault(); selectedGroup = null; activatePanelSection('groupsSection'); loadGroups().catch(error => message(error.message)); });
  $('agendaNavLink').addEventListener('click', event => { event.preventDefault(); activatePanelSection('agendaSection'); });
  $('songsNavLink').addEventListener('click', event => { event.preventDefault(); activatePanelSection('songsSection'); });
  document.querySelectorAll('.sidebar .nav-link').forEach(link => link.addEventListener('click', closeMobileMenu));
  $('userSearch').addEventListener('input', renderUsers);
  $('userStatusFilter').addEventListener('change', renderUsers);
  $('presetAllGroupsViewer').addEventListener('click', () => applyGroupPreset('all'));
  $('presetPrayerEbdViewer').addEventListener('click', () => applyGroupPreset('prayer-ebd'));
  $('clearGroupPermissions').addEventListener('click', () => applyGroupPreset('clear'));
  $('newGroupButton').addEventListener('click', () => openGroupForm());
  $('groupForm').addEventListener('submit', saveGroupForm);
  $('cancelGroupButton').addEventListener('click', () => closeEditor('groupFormWrap', 'groupForm'));
  $('cancelGroupBottomButton').addEventListener('click', () => closeEditor('groupFormWrap', 'groupForm'));
  $('backToGroupsButton').addEventListener('click', () => { activatePanelSection('groupsSection'); loadGroups().catch(error => message(error.message)); });
  $('newServiceButton').addEventListener('click', () => openServiceEditor());
  $('emptyNewServiceButton').addEventListener('click', () => openServiceEditor());
  $('serviceMonth').addEventListener('change', () => renderServices(groupServices));
  $('serviceForm').addEventListener('submit', saveServiceForm);
  $('serviceSingers').addEventListener('input', () => renderServicePersonLinks('singer'));
  $('serviceMusicians').addEventListener('input', () => renderServicePersonLinks('musician'));
  $('agendaPreviousMonth').addEventListener('click', () => { if (agendaMonth <= monthKey(new Date())) return; const [year, month] = agendaMonth.split('-').map(Number); const previous = new Date(year, month - 2, 1); agendaMonth = monthKey(previous); loadAgenda(); });
  $('agendaNextMonth').addEventListener('click', () => { const [year, month] = agendaMonth.split('-').map(Number); agendaMonth = monthKey(new Date(year, month, 1)); loadAgenda(); });
  $('agendaGroupFilter').addEventListener('change', renderAgenda);
  $('cancelServiceButton').addEventListener('click', () => closeEditor('serviceEditorWrap', 'serviceForm'));
  $('cancelServiceBottomButton').addEventListener('click', () => closeEditor('serviceEditorWrap', 'serviceForm'));
  $('addCatalogSongButton').addEventListener('click', () => { const song = songCatalog.find(row => row.id === $('songCatalogPicker').value); if (song) addServiceSong(song); });
  $('newSongFromServiceButton').addEventListener('click', () => openSongForm(null, true));
  $('newCatalogSongButton').addEventListener('click', () => openSongForm());
  $('emptyNewSongButton').addEventListener('click', () => openSongForm());
  $('songSearch').addEventListener('input', () => renderSongCatalog());
  $('songThemeFilter').addEventListener('change', renderSongCatalog);
  $('songStatusFilter').addEventListener('change', renderSongCatalog);
  $('songForm').addEventListener('submit', saveSongForm);
  $('songIsHymn').addEventListener('change', syncHymnArtistField);
  $('cancelSongButton').addEventListener('click', closeSongEditor);
  $('cancelSongBottomButton').addEventListener('click', closeSongEditor);
  $('importRepertoireButton').addEventListener('click', () => { $('importWrap').hidden = false; $('importRepertoireButton').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  $('closeImportButton').addEventListener('click', () => closeEditor('importWrap'));
  $('repertoireFile').addEventListener('change', async event => { const file = event.target.files?.[0]; if (file) $('repertoireText').value = await file.text(); });
  $('previewImportButton').addEventListener('click', async () => { try { await renderImportPreview(); } catch (error) { $('importPreview').hidden = true; $('saveImportButton').disabled = true; message(error.message); } });
  $('saveImportButton').addEventListener('click', saveImportDraft);
  const startSection = canSeeGroups() ? 'groupsSection' : canSeeSongs() ? 'songsSection' : canSeeUsers() ? 'userAdminSection' : 'groupsSection';
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
}

document.querySelectorAll('[data-password-toggle]').forEach(button => {
  button.addEventListener('click', () => {
    const input = $(button.dataset.passwordToggle);
    if (!input) return;
    const visible = input.type === 'password';
    input.type = visible ? 'text' : 'password';
    button.setAttribute('aria-pressed', String(visible));
    const label = button.getAttribute('aria-label') || 'Mostrar senha';
    button.setAttribute('aria-label', label.replace(/^(Mostrar|Ocultar)/, visible ? 'Ocultar' : 'Mostrar'));
    button.textContent = visible ? '◌' : '◉';
  });
});
$('phone').addEventListener('input', () => {
  maskPhoneInput($('phone'));
  $('loginFeedback').hidden = true;
});
$('password').addEventListener('input', () => { $('loginFeedback').hidden = true; });

$('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('loginButton');
  const label = $('loginButtonText');
  const feedback = $('loginFeedback');
  feedback.textContent = ''; feedback.hidden = true;
  button.disabled = true; button.setAttribute('aria-busy', 'true'); label.textContent = 'Entrando…';
  try {
    const email = phoneEmail($('phone').value);
    const data = await supabase('/auth/v1/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email, password: $('password').value }) });
    session = data; localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    await loadProfile();
  } catch (error) {
    session = null; localStorage.removeItem(STORAGE_KEY);
    feedback.textContent = error.message || 'Não foi possível entrar. Confira seus dados e tente novamente.';
    feedback.hidden = false;
  } finally {
    button.disabled = false; button.removeAttribute('aria-busy'); label.textContent = 'Entrar no painel';
  }
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
    showView('homeView'); setupDashboard();
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
