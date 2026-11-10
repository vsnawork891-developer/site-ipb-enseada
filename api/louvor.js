const URL = process.env.SUPABASE_URL;
const PUBLIC_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const SYSTEM_KEYS = ['library_view','library_create','library_edit','library_delete','groups_view','groups_create','groups_edit','groups_delete'];

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
  if (!response.ok) throw Object.assign(new Error(data?.message || data?.msg || 'Falha ao consultar o banco.'), { status: response.status });
  return data;
}
async function actorFor(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) throw Object.assign(new Error('Sessão não informada.'), { status: 401 });
  const auth = await fetch(`${URL}/auth/v1/user`, { headers: { apikey: PUBLIC_KEY, Authorization: `Bearer ${token}` } });
  if (!auth.ok) throw Object.assign(new Error('Sessão inválida ou expirada.'), { status: 401 });
  const user = await auth.json();
  const id = encodeURIComponent(user.id);
  const [profiles, permissions, memberships] = await Promise.all([
    rest(`profiles?select=id,role,is_owner,is_active,all_groups_access&id=eq.${id}&limit=1`),
    rest(`system_permissions?select=${SYSTEM_KEYS.join(',')}&user_id=eq.${id}&limit=1`),
    rest(`group_memberships?select=group_id,has_access,can_view,can_create,can_edit,can_delete&user_id=eq.${id}&has_access=eq.true`)
  ]);
  if (!profiles[0]?.is_active) throw Object.assign(new Error('Acesso inativo.'), { status: 403 });
  return { id: user.id, owner: profiles[0].is_owner === true || profiles[0].role === 'owner', allGroupsView: profiles[0].all_groups_access === true, permissions: permissions[0] || {}, memberships };
}
function permitted(actor, key) { return actor.owner || actor.permissions[key] === true; }
function groupAllowed(actor, id, action) {
  return actor.owner || (action === 'view' && (actor.allGroupsView || actor.permissions.groups_view === true)) || actor.memberships.some(row => row.group_id === id && row[`can_${action}`] === true);
}
function requirePermission(actor, key, message) { if (!permitted(actor, key)) throw Object.assign(new Error(message), { status: 403 }); }
function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')); }
function cleanText(value, max = 3000) { return String(value || '').trim().slice(0, max); }
function cleanUrl(value) {
  const text = cleanText(value, 1000);
  if (!text) return '';
  try { const parsed = new globalThis.URL(text); if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString(); }
  catch { /* reported below */ }
  throw Object.assign(new Error('Links devem começar com http:// ou https://.'), { status: 400 });
}
async function agendaAssignablePeople(groupId) {
  const [profiles, memberships, globalView] = await Promise.all([
    rest('profiles?select=id,full_name,is_active,is_owner,role,all_groups_access&is_active=eq.true&order=full_name.asc'),
    rest(`group_memberships?select=user_id&group_id=eq.${encodeURIComponent(groupId)}&has_access=eq.true&can_view=eq.true`),
    rest('system_permissions?select=user_id&groups_view=eq.true')
  ]);
  const memberIds = new Set(memberships.map(row => row.user_id));
  const globalIds = new Set(globalView.map(row => row.user_id));
  return profiles.filter(person => person.is_owner === true || person.role === 'owner' || person.all_groups_access === true || memberIds.has(person.id) || globalIds.has(person.id)).map(person => ({ id: person.id, full_name: person.full_name }));
}
async function serviceBundle(id) {
  const services = await rest(`worship_services?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
  if (!services[0]) return null;
  const [people, songs, snapshots] = await Promise.all([
    rest(`service_people?select=id,profile_id,role,name,position&service_id=eq.${encodeURIComponent(id)}&order=role.asc,position.asc`),
    rest(`service_songs?select=id,song_id,title_snapshot,artist_snapshot,soloist,male_key_snapshot,female_key_snapshot,youtube_url_snapshot,chart_url_snapshot,position&service_id=eq.${encodeURIComponent(id)}&order=position.asc`),
    rest(`service_snapshots?select=id,changed_by,created_at&service_id=eq.${encodeURIComponent(id)}&order=created_at.desc`)
  ]);
  return { ...services[0], people, songs, snapshots };
}
async function saveService(actor, body, editing) {
  const groupId = String(body.group_id || '');
  const action = editing ? 'edit' : 'create';
  if (!groupAllowed(actor, groupId, action)) throw Object.assign(new Error('Você não tem essa permissão neste grupo.'), { status: 403 });
  if (!validDate(body.service_date)) throw Object.assign(new Error('Informe uma data válida para o culto.'), { status: 400 });
  const people = Array.isArray(body.people) ? body.people : [];
  const songs = Array.isArray(body.songs) ? body.songs : [];
  if (songs.length > 8) throw Object.assign(new Error('Cada escala pode ter no máximo oito músicas.'), { status: 400 });
  if (songs.some(song => !cleanText(song.title_snapshot, 200))) throw Object.assign(new Error('Toda música precisa ter um título.'), { status: 400 });
  const serviceId = String(body.id || '');
  if (editing) {
    const old = await serviceBundle(serviceId);
    if (!old) throw Object.assign(new Error('Escala não encontrada.'), { status: 404 });
    if (!groupAllowed(actor, old.group_id, 'edit')) throw Object.assign(new Error('Você não tem permissão para editar esta escala.'), { status: 403 });
  }
  const cleanPeople = people.map((person, index) => ({ service_id: serviceId, role: person.role === 'musician' ? 'musician' : 'singer', name: cleanText(person.name, 120), profile_id: /^[0-9a-f-]{36}$/i.test(String(person.profile_id || '')) ? person.profile_id : null, position: index + 1 })).filter(person => person.name);
  const linkedIds = [...new Set(cleanPeople.map(person => person.profile_id).filter(Boolean))];
  if (linkedIds.length) {
    const assignableProfiles = await agendaAssignablePeople(groupId);
    const knownIds = new Set(assignableProfiles.map(row => row.id));
    if (linkedIds.some(id => !knownIds.has(id))) throw Object.assign(new Error('Um vínculo aponta para uma conta inativa ou sem acesso de visualização a este grupo. Revise os vínculos dos integrantes.'), { status: 400 });
  }
  const cleanSongs = songs.map((song, index) => ({
    song_id: song.song_id || null,
    title_snapshot: cleanText(song.title_snapshot, 200),
    artist_snapshot: cleanText(song.artist_snapshot, 200),
    soloist: cleanText(song.soloist, 200),
    male_key_snapshot: cleanText(song.male_key_snapshot, 40),
    female_key_snapshot: cleanText(song.female_key_snapshot, 40),
    youtube_url_snapshot: cleanUrl(song.youtube_url_snapshot),
    chart_url_snapshot: cleanUrl(song.chart_url_snapshot),
    position: index + 1
  }));
  if (cleanSongs.some(song => song.song_id && !/^[0-9a-f-]{36}$/i.test(song.song_id))) throw Object.assign(new Error('Uma música selecionada tem um identificador inválido.'), { status: 400 });
  const saved = await rest('rpc/panel_save_service', 'POST', {
    p_service_id: editing ? serviceId : null,
    p_group_id: groupId,
    p_service_date: body.service_date,
    p_theme: cleanText(body.theme, 240),
    p_actor: actor.id,
    p_people: cleanPeople,
    p_songs: cleanSongs
  });
  const savedId = typeof saved === 'string' ? saved : (saved?.panel_save_service || saved?.[0]?.panel_save_service);
  if (!savedId) throw Object.assign(new Error('O banco não retornou o identificador da escala salva.'), { status: 500 });
  return serviceBundle(savedId);
}

module.exports = async (req, res) => {
  if (!URL || !PUBLIC_KEY || !SECRET_KEY) return send(res, 500, { error: 'Configuração do servidor incompleta.' });
  try {
    const actor = await actorFor(req);
    const resource = String(req.query?.resource || req.body?.resource || '');
    if (resource === 'people' && req.method === 'GET') {
      const groupId = String(req.query?.group_id || '');
      if (!/^[0-9a-f-]{36}$/i.test(groupId)) throw Object.assign(new Error('Informe um grupo válido.'), { status: 400 });
      if (!groupAllowed(actor, groupId, 'create') && !groupAllowed(actor, groupId, 'edit')) throw Object.assign(new Error('Você não tem permissão para vincular integrantes neste grupo.'), { status: 403 });
      return send(res, 200, { people: await agendaAssignablePeople(groupId) });
    }
    if (resource === 'agenda' && req.method === 'GET') {
      const month = String(req.query?.month || '');
      if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw Object.assign(new Error('Informe o mês da agenda no formato AAAA-MM.'), { status: 400 });
      const [year, monthNumber] = month.split('-').map(Number);
      const monthStart = `${month}-01`;
      const monthEnd = `${year}-${String(monthNumber).padStart(2, '0')}-${String(new Date(year, monthNumber, 0).getDate()).padStart(2, '0')}`;
      const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());
      const fromDate = monthStart < today ? today : monthStart;
      if (fromDate > monthEnd) return send(res, 200, { month, events: [] });
      const assignments = await rest(`service_people?select=service_id&profile_id=eq.${encodeURIComponent(actor.id)}`);
      const serviceIds = [...new Set(assignments.map(row => row.service_id).filter(Boolean))];
      if (!serviceIds.length) return send(res, 200, { month, events: [] });
      const services = await rest(`worship_services?select=id,group_id,service_date,theme&id=in.(${serviceIds.map(encodeURIComponent).join(',')})&service_date=gte.${fromDate}&service_date=lte.${monthEnd}&order=service_date.asc`);
      if (!services.length) return send(res, 200, { month, events: [] });
      const groupIds = [...new Set(services.map(service => service.group_id))];
      const groups = await rest(`ministry_groups?select=id,name,service_weekday&id=in.(${groupIds.map(encodeURIComponent).join(',')})`);
      const groupById = new Map(groups.map(group => [group.id, group]));
      const events = services.filter(service => groupAllowed(actor, service.group_id, 'view') && groupById.has(service.group_id)).map(service => ({ ...service, group: groupById.get(service.group_id) }));
      return send(res, 200, { month, events });
    }
    if (resource === 'groups') {
      if (req.method === 'GET') {
        if (!actor.owner && !actor.allGroupsView && !SYSTEM_KEYS.filter(key => key.startsWith('groups_')).some(key => actor.permissions[key] === true) && !actor.memberships.some(row => row.can_view)) throw Object.assign(new Error('Você não tem permissão para consultar grupos.'), { status: 403 });
        const groups = await rest('ministry_groups?select=id,name,is_active,service_weekday&order=name.asc');
        const visibleGroups = groups.filter(group => groupAllowed(actor, group.id, 'view'));
        const activeIds = visibleGroups.filter(group => group.is_active).map(group => group.id);
        let upcoming = [];
        if (activeIds.length) {
          const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());
          upcoming = await rest(`worship_services?select=id,group_id,service_date,theme&group_id=in.(${activeIds.join(',')})&service_date=gte.${today}&order=service_date.asc`);
        }
        const nextByGroup = new Map();
        for (const service of upcoming) if (!nextByGroup.has(service.group_id)) nextByGroup.set(service.group_id, service);
        return send(res, 200, { groups: visibleGroups.map(group => ({ ...group, next_service: nextByGroup.get(group.id) || null })) });
      }
      const body = req.body || {};
      if (req.method === 'POST') {
        requirePermission(actor, 'groups_create', 'Você não tem permissão para criar grupos.');
        const name = cleanText(body.name, 100);
        if (!name) return send(res, 400, { error: 'Informe o nome do grupo.' });
        const duplicate = await rest(`ministry_groups?select=id&name=eq.${encodeURIComponent(name)}&limit=1`);
        if (duplicate.length) return send(res, 409, { error: 'Já existe um grupo com esse nome.' });
        const weekday = Number(body.service_weekday ?? 0);
        if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return send(res, 400, { error: 'Dia da semana inválido.' });
        const created = await rest('ministry_groups', 'POST', { name, is_active: true, service_weekday: weekday });
        return send(res, 201, { group: created?.[0] });
      }
      if (req.method === 'PATCH') {
        const id = String(body.id || '');
        requirePermission(actor, body.is_active === false ? 'groups_delete' : 'groups_edit', body.is_active === false ? 'Você não tem permissão para desativar grupos.' : 'Você não tem permissão para editar grupos.');
        const patch = {};
        if (body.name !== undefined) {
          patch.name = cleanText(body.name, 100);
          const duplicate = await rest(`ministry_groups?select=id&name=eq.${encodeURIComponent(patch.name)}&id=neq.${encodeURIComponent(id)}&limit=1`);
          if (duplicate.length) return send(res, 409, { error: 'Já existe um grupo com esse nome.' });
        }
        if (body.is_active !== undefined) patch.is_active = body.is_active === true;
        if (body.service_weekday !== undefined) {
          const weekday = Number(body.service_weekday);
          if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return send(res, 400, { error: 'Dia da semana inválido.' });
          patch.service_weekday = weekday;
        }
        const updated = await rest(`ministry_groups?id=eq.${encodeURIComponent(id)}`, 'PATCH', patch);
        return send(res, 200, { group: updated?.[0] });
      }
    }
    if (resource === 'songs') {
      if (req.method === 'GET') {
        if (!actor.owner && !SYSTEM_KEYS.filter(key => key.startsWith('library_')).some(key => actor.permissions[key] === true) && !actor.allGroupsView && !actor.memberships.some(row => row.can_view)) throw Object.assign(new Error('Você não tem permissão para consultar a biblioteca musical.'), { status: 403 });
        const search = cleanText(req.query?.q, 100).replace(/[^\p{L}\p{N} ]/gu, '').trim();
        const filter = search ? `&or=(title.ilike.*${encodeURIComponent(search)}*,artist.ilike.*${encodeURIComponent(search)}*,composer.ilike.*${encodeURIComponent(search)}*,themes.ilike.*${encodeURIComponent(search)}*)` : '';
        return send(res, 200, { songs: await rest(`songs_catalog?select=*&order=title.asc${filter}`) });
      }
      const body = req.body || {};
      if (req.method === 'POST') {
        requirePermission(actor, 'library_create', 'Você não tem permissão para cadastrar músicas.');
        const title = cleanText(body.title, 200);
        if (!title) return send(res, 400, { error: 'Informe o título da música.' });
        const row = { title, artist: cleanText(body.artist, 200), composer: cleanText(body.composer, 200), male_key: cleanText(body.male_key, 40), female_key: cleanText(body.female_key, 40), chart_url: cleanUrl(body.chart_url), youtube_url: cleanUrl(body.youtube_url), themes: cleanText(body.themes, 500), created_by: actor.id, updated_by: actor.id };
        return send(res, 201, { song: (await rest('songs_catalog', 'POST', row))?.[0] });
      }
      if (req.method === 'PATCH') {
        requirePermission(actor, 'library_edit', 'Você não tem permissão para editar músicas.');
        const id = String(body.id || '');
        const row = { title: cleanText(body.title, 200), artist: cleanText(body.artist, 200), composer: cleanText(body.composer, 200), male_key: cleanText(body.male_key, 40), female_key: cleanText(body.female_key, 40), chart_url: cleanUrl(body.chart_url), youtube_url: cleanUrl(body.youtube_url), themes: cleanText(body.themes, 500), updated_by: actor.id };
        return send(res, 200, { song: (await rest(`songs_catalog?id=eq.${encodeURIComponent(id)}`, 'PATCH', row))?.[0] });
      }
      if (req.method === 'DELETE') {
        requirePermission(actor, 'library_delete', 'Você não tem permissão para excluir músicas.');
        const deleted = await rest(`songs_catalog?id=eq.${encodeURIComponent(String(body.id || ''))}`, 'DELETE');
        return send(res, 200, { deleted: deleted?.length || 0 });
      }
    }
    if (resource === 'services') {
      if (req.method === 'GET') {
        const groupId = String(req.query?.group_id || '');
        if (!groupAllowed(actor, groupId, 'view')) throw Object.assign(new Error('Você não tem acesso a este grupo.'), { status: 403 });
        const services = await rest(`worship_services?select=*&group_id=eq.${encodeURIComponent(groupId)}&order=service_date.desc`);
        return send(res, 200, { services });
      }
    }
    if (resource === 'service') {
      if (req.method === 'GET') {
        const bundle = await serviceBundle(String(req.query?.id || ''));
        if (!bundle) return send(res, 404, { error: 'Escala não encontrada.' });
        if (!groupAllowed(actor, bundle.group_id, 'view')) throw Object.assign(new Error('Você não tem acesso a esta escala.'), { status: 403 });
        return send(res, 200, { service: bundle });
      }
      if (req.method === 'POST' || req.method === 'PATCH') {
        const bundle = await saveService(actor, req.body || {}, req.method === 'PATCH');
        return send(res, req.method === 'POST' ? 201 : 200, { service: bundle });
      }
    }
    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return send(res, 404, { error: 'Recurso não encontrado ou método não permitido.' });
  } catch (error) {
    return send(res, error.status || 500, { error: error.message || 'Não foi possível concluir a operação.' });
  }
};
