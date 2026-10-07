// Vercel Serverless Function
// GET  /api/state  -> { tasks, atas, updatedAt }
// POST /api/state  -> { action: 'seed' | 'add_task' | 'update_task' | 'add_ata', ... }
//
// Guarda as tarefas e atas do dashboard no Redis (Upstash) via REST, sem dependências.
// A integração do Upstash na Vercel injeta KV_REST_API_URL e KV_REST_API_TOKEN
// (também aceitamos UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).
// Sem Redis configurado responde 503 e o dashboard abre em modo leitura.

const K_TASKS = 'iconic:tasks';
const K_ATAS = 'iconic:atas';
const STATUSES = ['backlog', 'waiting', 'ongoing', 'done'];
const OWNERS = ['iconic', 'hubii'];
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

// Aceita os nomes padrão e também com prefixo (ex.: STORAGE_KV_REST_API_URL), caso o instalador adicione um.
function findEnv(suffixes) {
  for (const name of suffixes) if (process.env[name]) return process.env[name];
  const key = Object.keys(process.env).find((k) => suffixes.some((s) => k.endsWith('_' + s)) && process.env[k]);
  return key ? process.env[key] : undefined;
}
function cfg() {
  const url = findEnv(['UPSTASH_REDIS_REST_URL', 'KV_REST_API_URL']);
  const token = findEnv(['UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_TOKEN']);
  if (!url || !token) return null;
  return { url: String(url).trim().replace(/\/+$/, ''), token: String(token).trim() };
}

async function pipeline(c, commands) {
  const r = await fetch(`${c.url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  let j;
  try { j = await r.json(); } catch (e) { j = null; }
  if (!r.ok || !Array.isArray(j)) throw new Error(`redis HTTP ${r.status}${j && j.error ? ': ' + j.error : ''}`);
  return j.map((x) => {
    if (x && x.error) throw new Error('redis: ' + x.error);
    return x ? x.result : null;
  });
}

// HGETALL via REST devolve lista plana [campo, valor, ...]
function toObject(res) {
  if (!res) return {};
  if (!Array.isArray(res)) return res;
  const o = {};
  for (let i = 0; i < res.length; i += 2) o[res[i]] = res[i + 1];
  return o;
}
function parseValues(obj) {
  const out = {};
  Object.entries(obj).forEach(([k, v]) => {
    try { out[k] = typeof v === 'string' ? JSON.parse(v) : v; } catch (e) { /* ignora valor corrompido */ }
  });
  return out;
}

async function readState(c) {
  const [t, a] = await pipeline(c, [['HGETALL', K_TASKS], ['HGETALL', K_ATAS]]);
  const tasks = parseValues(toObject(t));
  const atas = parseValues(toObject(a));
  let updatedAt = null;
  [...Object.values(tasks), ...Object.values(atas)].forEach((x) => {
    if (x && x.updatedAt && (!updatedAt || x.updatedAt > updatedAt)) updatedAt = x.updatedAt;
  });
  return { tasks, atas, updatedAt };
}

const str = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const longStr = (v, max) => String(v == null ? '' : v).replace(/\r/g, '').trim().slice(0, max);
const nowIso = () => new Date().toISOString();
const todayLabel = () => {
  const d = new Date(Date.now() - 3 * 3600 * 1000); // horário de Brasília
  return String(d.getUTCDate()).padStart(2, '0') + '-' + MESES[d.getUTCMonth()];
};
const newId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

function badRequest(res, msg) { return res.status(400).json({ error: msg }); }

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const c = cfg();
  if (!c) return res.status(503).json({ error: 'armazenamento não configurado' });

  try {
    if (req.method === 'GET') return res.status(200).json(await readState(c));
    if (req.method !== 'POST') return res.status(405).json({ error: 'método não permitido' });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
    if (!body || typeof body !== 'object') return badRequest(res, 'corpo inválido');
    const action = body.action;

    if (action === 'seed') {
      // só semeia se o Redis estiver vazio (idempotente)
      const [len] = await pipeline(c, [['HLEN', K_TASKS]]);
      if (!len && body.tasks && typeof body.tasks === 'object') {
        const args = ['HSET', K_TASKS];
        const stamp = nowIso();
        Object.entries(body.tasks).slice(0, 100).forEach(([key, t]) => {
          if (!/^t_[a-z0-9_]{1,60}$/.test(key) || !t) return;
          if (!OWNERS.includes(t.owner) || !STATUSES.includes(t.status)) return;
          const updates = (Array.isArray(t.updates) ? t.updates : []).slice(0, 100).map((u) => ({ date: str(u.date, 12), text: longStr(u.text, 600) }));
          args.push(key, JSON.stringify({
            title: str(t.title, 160), owner: t.owner, status: t.status,
            order: Number(t.order) || 0, updates, createdAt: stamp, updatedAt: stamp,
          }));
        });
        if (args.length > 2) await pipeline(c, [args]);
      }
      return res.status(200).json(await readState(c));
    }

    if (action === 'add_task') {
      const title = str(body.title, 160);
      if (!title) return badRequest(res, 'título obrigatório');
      const owner = OWNERS.includes(body.owner) ? body.owner : 'hubii';
      const status = STATUSES.includes(body.status) ? body.status : 'backlog';
      const note = longStr(body.note, 600);
      const stamp = nowIso();
      const task = {
        title, owner, status, order: Date.now(),
        updates: note ? [{ date: todayLabel(), text: note }] : [],
        createdAt: stamp, updatedAt: stamp,
      };
      await pipeline(c, [['HSET', K_TASKS, newId('t_'), JSON.stringify(task)]]);
      return res.status(200).json(await readState(c));
    }

    if (action === 'update_task') {
      const key = String(body.key || '');
      if (!/^t_[a-z0-9_]{1,60}$/.test(key)) return badRequest(res, 'tarefa inválida');
      const [raw] = await pipeline(c, [['HGET', K_TASKS, key]]);
      if (!raw) return res.status(404).json({ error: 'tarefa não encontrada' });
      const t = JSON.parse(raw);
      if (body.status !== undefined && body.status !== null) {
        if (!STATUSES.includes(body.status)) return badRequest(res, 'status inválido');
        t.status = body.status;
      }
      if (body.owner !== undefined && body.owner !== null) {
        if (!OWNERS.includes(body.owner)) return badRequest(res, 'responsável inválido');
        t.owner = body.owner;
      }
      if (body.title !== undefined && body.title !== null) {
        const title = str(body.title, 160);
        if (!title) return badRequest(res, 'título vazio');
        t.title = title;
      }
      const note = longStr(body.note, 600);
      if (note) {
        t.updates = (Array.isArray(t.updates) ? t.updates : []).concat([{ date: todayLabel(), text: note }]).slice(-200);
      }
      t.updatedAt = nowIso();
      await pipeline(c, [['HSET', K_TASKS, key, JSON.stringify(t)]]);
      return res.status(200).json(await readState(c));
    }

    if (action === 'add_ata') {
      const title = str(body.title, 160);
      const date = String(body.date || '');
      if (!title) return badRequest(res, 'título obrigatório');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return badRequest(res, 'data inválida');
      const sections = (Array.isArray(body.sections) ? body.sections : []).slice(0, 6).map((s) => ({
        label: str(s && s.label, 60),
        items: (Array.isArray(s && s.items) ? s.items : []).slice(0, 30).map((i) => longStr(i, 500)).filter(Boolean),
      })).filter((s) => s.label && s.items.length);
      if (!sections.length) return badRequest(res, 'a ata precisa de pelo menos um item');
      const stamp = nowIso();
      const ata = { title, date, sub: str(body.sub, 300), sections, createdAt: stamp, updatedAt: stamp };
      await pipeline(c, [['HSET', K_ATAS, newId('a_'), JSON.stringify(ata)]]);
      return res.status(200).json(await readState(c));
    }

    return badRequest(res, 'ação desconhecida');
  } catch (err) {
    console.error('[state] exception', err.message);
    return res.status(502).json({ error: 'falha ao acessar o armazenamento' });
  }
};
