// Vercel Serverless Function: /api/notion-tasks
// Lista as tarefas da database Tasks List do Notion. Token só em NOTION_TOKEN.

const NOTION_VERSION = "2022-06-28";
const DB_ID = process.env.NOTION_TASKS_DB_ID || "3b9ef5854ef380ec84e0d4cc4c8fe98a";
const MAX_TASKS = 1000;

function plainText(prop) {
  if (!prop || !Array.isArray(prop.title)) return "";
  return prop.title.map((t) => t.plain_text || "").join("").trim();
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  const token = process.env.NOTION_TOKEN;
  if (!token) {
    return res.status(500).json({ error: "Configuração ausente no servidor" });
  }

  res.setHeader("Cache-Control", "no-store");

  const pages = [];
  let cursor = null;

  try {
    do {
      const body = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;

      const r = await fetch(`https://api.notion.com/v1/databases/${DB_ID}/query`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!r.ok) {
        console.error("Notion query falhou", r.status);
        return res.status(502).json({ error: "Falha ao ler o Notion" });
      }

      const j = await r.json();
      pages.push(...(j.results || []));
      cursor = j.has_more ? j.next_cursor : null;
    } while (cursor && pages.length < MAX_TASKS);
  } catch (err) {
    console.error("Erro de rede com Notion", err);
    return res.status(502).json({ error: "Falha de comunicação com o Notion" });
  }

  const tasks = pages
    .map((p) => {
      const props = p.properties || {};
      return {
        id: p.id,
        title: plainText(props["Nome da tarefa"]),
        status: props.Status && props.Status.status ? props.Status.status.name : null,
        owner: props.Owner && props.Owner.select ? props.Owner.select.name : null,
        url: p.url,
      };
    })
    .filter((t) => t.title);

  return res.status(200).json({ tasks, fetchedAt: new Date().toISOString() });
}
