// Vercel Serverless Function
// POST /api/complete-task
// body: { pageId: string, done: boolean }
//
// Marca (ou desmarca) o Status da task no Notion.
// "Status" é uma propriedade do tipo "status" (não "select") nesta database,
// então o corpo precisa usar { status: { name: "..." } }.

module.exports = async function handler(req, res) {
  console.log('[complete-task] invoked', { method: req.method });

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { pageId, done } = req.body || {};
  console.log('[complete-task] body', { pageId, done });

  if (!pageId) {
    return res.status(400).json({ error: 'pageId é obrigatório' });
  }

  const token = process.env.NOTION_TOKEN;
  console.log('[complete-task] NOTION_TOKEN presente?', !!token, 'tamanho:', token ? token.length : 0);

  if (!token) {
    console.error('[complete-task] NOTION_TOKEN ausente no ambiente');
    return res.status(500).json({ error: 'NOTION_TOKEN não configurado no ambiente da Vercel' });
  }

  const statusName = done === false ? 'Waiting' : 'Done';

  try {
    const response = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        properties: {
          Status: { status: { name: statusName } },
        },
      }),
    });

    const data = await response.json();
    console.log('[complete-task] resposta Notion', { status: response.status, ok: response.ok });

    if (!response.ok) {
      console.error('[complete-task] erro Notion', JSON.stringify(data).slice(0, 500));
      return res.status(response.status).json({ error: data });
    }

    return res.status(200).json({ success: true, status: statusName });
  } catch (err) {
    console.error('[complete-task] exception', err.message);
    return res.status(500).json({ error: err.message });
  }
}
