// Vercel Serverless Function
// GET/POST /api/refresh-tasks
//
// Busca o status mais recente de todas as tarefas da Iconic direto no Notion,
// sem precisar de um redeploy do dashboard. Usado pelo botão "Atualizado em".

module.exports = async function handler(req, res) {
  console.log('[refresh-tasks] invoked', { method: req.method });

  const token = process.env.NOTION_TOKEN;
  console.log('[refresh-tasks] NOTION_TOKEN presente?', !!token);

  if (!token) {
    return res.status(500).json({ error: 'NOTION_TOKEN não configurado no ambiente da Vercel' });
  }

  const DATABASE_ID = '3b9ef585-4ef3-800e-b444-000b7d3a1845';
  const ICONIC_COMPANY_ID = '34cef585-4ef3-806b-b4e9-cd67a2b3a07e';

  const headers = {
    Authorization: `Bearer ${token}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };

  try {
    const response = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        filter: {
          property: 'Companies',
          relation: { contains: ICONIC_COMPANY_ID },
        },
        page_size: 100,
      }),
    });

    const data = await response.json();
    console.log('[refresh-tasks] Notion query status', response.status);

    if (!response.ok) {
      console.error('[refresh-tasks] erro Notion', JSON.stringify(data).slice(0, 500));
      return res.status(response.status).json({ error: data });
    }

    const tasks = (data.results || []).map((page) => {
      const props = page.properties || {};
      const titleProp = props['Nome da tarefa'];
      const title = (titleProp && titleProp.title || []).map((t) => t.plain_text).join('');
      const status = props.Status && props.Status.status ? props.Status.status.name : null;
      const owner = props.Owner && props.Owner.select ? props.Owner.select.name : null;
      return { pageId: page.id, title, status, owner };
    });

    return res.status(200).json({ tasks, refreshedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[refresh-tasks] exception', err.message);
    return res.status(500).json({ error: err.message });
  }
};
