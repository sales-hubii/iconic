// Vercel Serverless Function: /api/notion-task-status
// Atualiza o status de uma task na database Task List do Notion.
//
// Variáveis de ambiente (configurar em Vercel > Project > Settings > Environment Variables):
//   NOTION_TOKEN            token de acesso da integração (NUNCA colocar no HTML ou no repositório)
//   NOTION_STATUS_PROP      nome da propriedade de status no Notion (ex.: "Status")
//
// Requisição esperada (POST, JSON):
//   { "pageId": "<uuid da página>", "status": "Done" }
//
// Schema verificado (database "Tasks List"): propriedade "Status" é do tipo "status".
// Título da página: "Nome da tarefa". Não use o ID da view (?v=) nem o da página Projects.

const NOTION_VERSION = "2022-06-28";
// Valores reais da propriedade "Status" da database Tasks List (schema verificado).
const ALLOWED_STATUS = ["Backlog", "To-Do", "Waiting", "On Going", "Paused", "Done"];

const ALLOWED_ORIGINS = [
  "https://iconic.brand-dataroom.hubii.com.br",
];

const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  const token = process.env.NOTION_TOKEN;
  const statusProp = process.env.NOTION_STATUS_PROP || "Status";
  if (!token) {
    return res.status(500).json({ error: "Configuração ausente no servidor" });
  }

  const { pageId, status } = req.body || {};

  if (typeof pageId !== "string" || !UUID_RE.test(pageId)) {
    return res.status(400).json({ error: "pageId inválido" });
  }
  if (!ALLOWED_STATUS.includes(status)) {
    return res.status(400).json({ error: "status inválido" });
  }

  try {
    const notionRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        properties: {
          [statusProp]: { status: { name: status } },
        },
      }),
    });

    if (!notionRes.ok) {
      // Não repassar corpo bruto da Notion ao cliente (pode conter detalhes internos).
      console.error("Notion PATCH falhou", notionRes.status);
      return res.status(502).json({ error: "Falha ao atualizar no Notion" });
    }

    const page = await notionRes.json();
    return res.status(200).json({ ok: true, id: page.id, last_edited_time: page.last_edited_time });
  } catch (err) {
    console.error("Erro de rede com Notion", err);
    return res.status(502).json({ error: "Falha de comunicação com o Notion" });
  }
}
