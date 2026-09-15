// Vercel Serverless Function
// POST /api/add-update
// body: { pageId: string, date: string, text: string }
//
// Adiciona uma nova linha (bullet) na seção "## Last Update" da página no Notion,
// sem apagar o histórico anterior — mesmo padrão já usado manualmente:
// "- DD-mmm.: descrição"

const HEADING_TYPES = ['heading_1', 'heading_2', 'heading_3'];

function getPlainText(block) {
  const type = block.type;
  const richText = block[type] && block[type].rich_text;
  if (!richText) return '';
  return richText.map((rt) => rt.plain_text || '').join('');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { pageId, date, text } = req.body || {};

  if (!pageId || !date || !text) {
    return res.status(400).json({ error: 'pageId, date e text são obrigatórios' });
  }

  const token = process.env.NOTION_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'NOTION_TOKEN não configurado no ambiente da Vercel' });
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };

  try {
    // 1. Listar os blocos filhos da página para achar o heading "Last Update"
    const listRes = await fetch(
      `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`,
      { headers }
    );
    const listData = await listRes.json();

    if (!listRes.ok) {
      return res.status(listRes.status).json({ error: listData });
    }

    const blocks = listData.results || [];

    let headingIndex = -1;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (HEADING_TYPES.includes(b.type)) {
        const plain = getPlainText(b).trim().toLowerCase();
        if (plain === 'last update') {
          headingIndex = i;
          break;
        }
      }
    }

    if (headingIndex === -1) {
      return res.status(404).json({ error: 'Seção "Last Update" não encontrada nesta página' });
    }

    // 2. Achar o último bullet logo após o heading (sequência contínua)
    let afterBlockId = blocks[headingIndex].id;
    for (let i = headingIndex + 1; i < blocks.length; i++) {
      if (blocks[i].type === 'bulleted_list_item') {
        afterBlockId = blocks[i].id;
      } else {
        break;
      }
    }

    // 3. Inserir o novo bullet logo depois
    const newBlock = {
      object: 'block',
      type: 'bulleted_list_item',
      bulleted_list_item: {
        rich_text: [
          {
            type: 'text',
            text: { content: `${date}: ${text}` },
          },
        ],
      },
    };

    const appendRes = await fetch(
      `https://api.notion.com/v1/blocks/${pageId}/children`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          children: [newBlock],
          after: afterBlockId,
        }),
      }
    );
    const appendData = await appendRes.json();

    if (!appendRes.ok) {
      return res.status(appendRes.status).json({ error: appendData });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
