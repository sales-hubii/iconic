// Vercel Serverless Function: /api/tasks
// GET  /api/tasks                    -> { tasks, atas, updatedAt }
// GET  /api/tasks?comments=<pageId>  -> { updates: [{ date, text }] }   (histórico = comentários da página)
// POST /api/tasks  { action: 'update' | 'comment' | 'create', ... }      -> estado atualizado (update/create)
//
// Fonte única: Notion. Tarefas = database "Tasks List"; atas = database "Meeting Notes".
// Ambas filtradas pela relação Companies = Iconic. Atas são somente leitura.
// Variável de ambiente: NOTION_TOKEN (integração com acesso às duas databases e
// capacidade de ler e inserir comentários).

const NOTION = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const TASKS_DB = '3b9ef5854ef380ec84e0d4cc4c8fe98a';
const MEETINGS_DB = '2edef5854ef38038a9c7f59d73c1c6da';
const ICONIC_ID = '34cef585-4ef3-806b-b4e9-cd67a2b3a07e';
const OWNERS = ['Parceiro', 'Hubii', 'Ambos'];
const STATUSES = ['Backlog', 'To-Do', 'Waiting', 'On Going', 'Paused', 'Done'];
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const COMPANY_FILTER = { property: 'Companies', relation: { contains: ICONIC_ID } };

async function notion(token, method, path, body) {
  const r = await fetch(`${NOTION}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  if (!r.ok) {
    console.error('[tasks] notion', r.status, j && j.code);
    throw new Error('notion ' + r.status);
  }
  return j;
}

async function queryAll(token, dbId, body) {
  const out = [];
  let cursor = null;
  do {
    const j = await notion(token, 'POST', `/databases/${dbId}/query`, {
      ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}),
    });
    out.push(...(j.results || []));
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor && out.length < 1000);
  return out;
}

const plain = (arr) => (Array.isArray(arr) ? arr.map((t) => t.plain_text || '').join('') : '').trim();
const titleOf = (props) => {
  for (const p of Object.values(props)) if (p && p.type === 'title') return plain(p.title);
  return '';
};

function dayLabel(iso) {
  const d = new Date(new Date(iso).getTime() - 3 * 3600 * 1000); // horário de Brasília
  return String(d.getUTCDate()).padStart(2, '0') + '-' + MESES[d.getUTCMonth()];
}

function mapTask(p) {
  const props = p.properties || {};
  return {
    title: plain(props['Nome da tarefa'] && props['Nome da tarefa'].title),
    status: props.Status && props.Status.status ? props.Status.status.name : 'Backlog',
    owner: props.Owner && props.Owner.select ? props.Owner.select.name : 'Parceiro',
    week: props.Week && typeof props.Week.number === 'number' ? props.Week.number : null,
    updates: [],
    updatesLoaded: false,
    url: p.url,
  };
}

function mapAta(p) {
  const props = p.properties || {};
  const iso = props.Date && props.Date.date ? props.Date.date.start : (p.created_time || '');
  return { title: titleOf(props), date: String(iso).slice(0, 10), sub: '', sections: [], url: p.url };
}

// Conteúdo das atas: lido dos blocos da página, com cache em memória (10 min).
const ATA_CACHE = new Map();
const ATA_TTL = 10 * 60 * 1000;
const TEXT_TYPES = ['paragraph', 'bulleted_list_item', 'numbered_list_item', 'to_do', 'quote', 'callout'];
const HEAD_TYPES = ['heading_1', 'heading_2', 'heading_3'];
const SKIP_CHILDREN = ['child_page', 'child_database', 'synced_block'];

async function listChildren(token, blockId) {
  const out = [];
  let cursor = null;
  do {
    const j = await notion(token, 'GET', `/blocks/${blockId}/children?page_size=100${cursor ? '&start_cursor=' + cursor : ''}`);
    out.push(...(j.results || []));
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor && out.length < 300);
  return out;
}

async function collectAta(token, blockId, depth, acc) {
  if (depth > 3) return;
  const blocks = await listChildren(token, blockId);
  for (const b of blocks) {
    acc.types.add(b.type);
    if (acc.items >= 80) return;
    const body = b[b.type];
    if (HEAD_TYPES.includes(b.type)) {
      const t = body ? plain(body.rich_text) : '';
      if (t) acc.sections.push({ label: t, items: [] });
    } else if (TEXT_TYPES.includes(b.type)) {
      const t = body ? plain(body.rich_text) : '';
      if (t) {
        if (!acc.sections.length) acc.sections.push({ label: 'Resumo', items: [] });
        acc.sections[acc.sections.length - 1].items.push(t);
        acc.items++;
      }
    }
    if (b.has_children && !SKIP_CHILDREN.includes(b.type)) await collectAta(token, b.id, depth + 1, acc);
  }
}

async function fetchAtaContent(token, pageId) {
  const hit = ATA_CACHE.get(pageId);
  if (hit && Date.now() - hit.at < ATA_TTL) return hit.sections;
  const acc = { sections: [], items: 0, types: new Set() };
  await collectAta(token, pageId, 0, acc);
  const sections = acc.sections.filter((s) => s.items.length);
  if (!sections.length) console.log('[tasks] ata sem texto', pageId, [...acc.types].join(','));
  ATA_CACHE.set(pageId, { at: Date.now(), sections });
  return sections;
}

async function readState(token) {
  const [tasksRaw, atasRaw] = await Promise.all([
    queryAll(token, TASKS_DB, { filter: COMPANY_FILTER, sorts: [{ timestamp: 'created_time', direction: 'ascending' }] }),
    queryAll(token, MEETINGS_DB, { filter: COMPANY_FILTER }).catch((e) => {
      console.error('[tasks] atas indisponíveis:', e.message);
      return [];
    }),
  ]);
  const tasks = {};
  tasksRaw.forEach((p, i) => { tasks[p.id] = { ...mapTask(p), order: i }; });
  const atas = {};
  const ordered = atasRaw.map((p) => ({ id: p.id, ...mapAta(p) })).sort((a, b) => b.date.localeCompare(a.date));
  for (let i = 0; i < ordered.length; i++) {
    const a = ordered[i];
    const { id, ...rest } = a;
    if (i < 5) {
      try { rest.sections = await fetchAtaContent(token, id); rest.loaded = true; }
      catch (e) { console.error('[tasks] ata sem conteúdo:', e.message); }
    }
    atas[id] = rest;
  }
  return { tasks, atas, updatedAt: new Date().toISOString() };
}

async function fetchUpdates(token, pageId) {
  const j = await notion(token, 'GET', `/comments?block_id=${pageId}&page_size=100`);
  return (j.results || []).map((c) => ({ date: dayLabel(c.created_time), text: plain(c.rich_text) }));
}

async function addComment(token, pageId, text) {
  await notion(token, 'POST', '/comments', {
    parent: { page_id: pageId },
    rich_text: [{ type: 'text', text: { content: text } }],
  });
}

const str = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const longStr = (v, max) => String(v == null ? '' : v).replace(/\r/g, '').trim().slice(0, max);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const token = process.env.NOTION_TOKEN;
  if (!token) return res.status(503).json({ error: 'armazenamento não configurado' });

  try {
    if (req.method === 'GET') {
      const ataId = req.query && req.query.ata;
      if (ataId) {
        if (!UUID_RE.test(ataId)) return res.status(400).json({ error: 'ataId inválido' });
        return res.status(200).json({ sections: await fetchAtaContent(token, ataId) });
      }
      const pid = req.query && req.query.comments;
      if (pid) {
        if (!UUID_RE.test(pid)) return res.status(400).json({ error: 'pageId inválido' });
        return res.status(200).json({ updates: await fetchUpdates(token, pid) });
      }
      return res.status(200).json(await readState(token));
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'método não permitido' });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
    if (!body || typeof body !== 'object') return res.status(400).json({ error: 'corpo inválido' });

    if (body.action === 'update') {
      if (typeof body.pageId !== 'string' || !UUID_RE.test(body.pageId)) return res.status(400).json({ error: 'pageId inválido' });
      const props = {};
      if (body.status !== undefined) {
        if (!STATUSES.includes(body.status)) return res.status(400).json({ error: 'status inválido' });
        props.Status = { status: { name: body.status } };
      }
      if (body.owner !== undefined) {
        if (!OWNERS.includes(body.owner)) return res.status(400).json({ error: 'responsável inválido' });
        props.Owner = { select: { name: body.owner } };
      }
      if (Object.keys(props).length) await notion(token, 'PATCH', `/pages/${body.pageId}`, { properties: props });
      return res.status(200).json(await readState(token));
    }

    if (body.action === 'comment') {
      if (typeof body.pageId !== 'string' || !UUID_RE.test(body.pageId)) return res.status(400).json({ error: 'pageId inválido' });
      const text = longStr(body.text, 2000);
      if (!text) return res.status(400).json({ error: 'texto obrigatório' });
      await addComment(token, body.pageId, text);
      return res.status(200).json({ ok: true });
    }

    if (body.action === 'create') {
      const title = str(body.title, 160);
      if (!title) return res.status(400).json({ error: 'título obrigatório' });
      const owner = OWNERS.includes(body.owner) ? body.owner : 'Hubii';
      const status = STATUSES.includes(body.status) ? body.status : 'Backlog';
      const page = await notion(token, 'POST', '/pages', {
        parent: { database_id: TASKS_DB },
        properties: {
          'Nome da tarefa': { title: [{ type: 'text', text: { content: title } }] },
          Status: { status: { name: status } },
          Owner: { select: { name: owner } },
          Companies: { relation: [{ id: ICONIC_ID }] },
        },
      });
      const note = longStr(body.note, 2000);
      if (note) await addComment(token, page.id, note);
      return res.status(200).json(await readState(token));
    }

    return res.status(400).json({ error: 'ação desconhecida' });
  } catch (err) {
    console.error('[tasks] exception', err.message);
    return res.status(502).json({ error: 'falha ao acessar o Notion' });
  }
}
