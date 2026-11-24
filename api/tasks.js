// Vercel Serverless Function
// GET /api/tasks
//
// Lê do Notion as tarefas da Company Ultragaz (base "Tasks List", relação
// "Companies") e devolve no formato que o index.html espera. Usa o mesmo
// NOTION_TOKEN das outras funções — a integração precisa ter acesso à base
// Tasks List e à página Companies/Ultragaz.
//
// IDs podem ser sobrescritos por variáveis de ambiente na Vercel:
//   NOTION_TASKS_DB_ID, NOTION_COMPANY_ID

const TASKS_DB_ID = process.env.NOTION_TASKS_DB_ID || '3b9ef585-4ef3-80ec-84e0-d4cc4c8fe98a';
const COMPANY_ID = process.env.NOTION_COMPANY_ID || '24def585-4ef3-8079-a874-d02c63bdb656';

const VALID_STATUSES = ['Backlog', 'To-Do', 'Waiting', 'On Going', 'Paused', 'Done'];
const HEADING_TYPES = ['heading_1', 'heading_2', 'heading_3'];

const plain = (rt) => (rt || []).map((r) => r.plain_text || '').join('');

async function notion(path, token, init = {}) {
  const resp = await fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
  });
  const data = await resp.json();
  if (!resp.ok) {
    const err = new Error(data.message || `Notion HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  return data;
}

// Bullets da seção "Last Update" no formato "DD-mmm: texto"
async function readUpdates(pageId, token) {
  try {
    const data = await notion(`/blocks/${pageId}/children?page_size=100`, token);
    const blocks = data.results || [];
    const h = blocks.findIndex(
      (b) => HEADING_TYPES.includes(b.type) && plain(b[b.type].rich_text).trim().toLowerCase() === 'last update'
    );
    if (h === -1) return [];
    const updates = [];
    for (let i = h + 1; i < blocks.length && blocks[i].type === 'bulleted_list_item'; i++) {
      const text = plain(blocks[i].bulleted_list_item.rich_text).trim();
      const m = text.match(/^(\d{1,2}-[a-zçé]{3}\.?)\s*:\s*([\s\S]*)$/i);
      updates.push(m ? { date: m[1], text: m[2] } : { date: '', text });
    }
    return updates;
  } catch (e) {
    return []; // histórico é complementar; não derruba a lista de tarefas
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'NOTION_TOKEN não configurado no ambiente da Vercel' });
  }

  try {
    const pages = [];
    let cursor;
    do {
      const body = {
        page_size: 100,
        filter: { property: 'Companies', relation: { contains: COMPANY_ID } },
        sorts: [{ timestamp: 'created_time', direction: 'ascending' }],
      };
      if (cursor) body.start_cursor = cursor;
      const data = await notion(`/databases/${TASKS_DB_ID}/query`, token, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      pages.push(...data.results);
      cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);

    const rows = pages
      .map((p) => {
        const props = p.properties || {};
        const title = plain(props['Nome da tarefa'] && props['Nome da tarefa'].title).trim();
        const status = props.Status && props.Status.status && props.Status.status.name;
        const owner = props.Owner && props.Owner.select && props.Owner.select.name;
        const week = props.Week && props.Week.number;
        return { p, title, status, owner, week };
      })
      .filter((r) => r.title); // ignora linhas sem nome (ex.: "Novo(a) tarefa" em branco)

    const tasks = await Promise.all(
      rows.map(async (r, i) => {
        const status = VALID_STATUSES.includes(r.status) ? r.status : 'Backlog';
        return {
          // ID completo: os 8 primeiros caracteres se repetem entre páginas do
          // mesmo workspace (ex.: 3dcef585…, 24def585…) e geravam chaves duplicadas.
          key: 't_' + r.p.id.replace(/-/g, ''),
          title: r.title,
          owner: r.owner || 'Hubii',
          status,
          originalStatus: status,
          semana: r.week ? `2026-W${String(r.week).padStart(2, '0')}` : '',
          ordem: i + 1,
          url: r.p.url,
          updates: await readUpdates(r.p.id, token),
        };
      })
    );

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ tasks, fetchedAt: new Date().toISOString() });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
};
