// api/publish.js
// Publica um arquivo no repositório sales-hubii/iconic via API do GitHub.
//
// Variáveis de ambiente necessárias na Vercel (projeto Iconic):
//   CLAUDE_GIT_ICONIC_TOKEN  -> token do GitHub (fine-grained, Contents: Read and write)
//   PUBLISH_SECRET           -> segredo próprio desta função (gere um valor longo e aleatório)
//
// Chamada:
//   POST /api/publish
//   Header: x-publish-secret: <PUBLISH_SECRET>
//   Body JSON: { "path": "index.html", "content": "<conteúdo do arquivo>", "message": "descrição do commit" }

const crypto = require('crypto');

const OWNER = 'sales-hubii';
const REPO = 'iconic';
const BRANCH = 'main';

// Só estes caminhos podem ser alterados por esta função.
const ALLOWED_PATHS = new Set([
  'index.html',
  'resultados-data.json',
  'teste-claude.txt', // usado só para o teste de commit; remova depois
]);

const MAX_CONTENT_BYTES = 2 * 1024 * 1024; // 2 MB

function secretOk(received) {
  const expected = process.env.PUBLISH_SECRET || '';
  if (!expected || typeof received !== 'string') return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function ghFetch(url, token, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* sem corpo JSON */ }
  return { status: res.status, data };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Método não permitido' });
  }

  if (!secretOk(req.headers['x-publish-secret'])) {
    return res.status(401).json({ error: 'Não autorizado' });
  }

  const token = process.env.CLAUDE_GIT_ICONIC_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'Token do GitHub não configurado' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const { path, content, message } = body;

  if (!ALLOWED_PATHS.has(path)) {
    return res.status(400).json({ error: 'Caminho não permitido', path });
  }
  if (typeof content !== 'string' || !content.length) {
    return res.status(400).json({ error: 'Conteúdo vazio ou inválido' });
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    return res.status(413).json({ error: 'Conteúdo maior que o limite de 2 MB' });
  }

  const msg = (typeof message === 'string' && message.trim()) || `Atualiza ${path} via publish`;
  const apiBase = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path)}`;

  // 1. Descobre o SHA atual do arquivo (necessário para atualizar)
  const current = await ghFetch(`${apiBase}?ref=${BRANCH}`, token);
  let sha;
  if (current.status === 200 && current.data && current.data.sha) {
    sha = current.data.sha;
  } else if (current.status !== 404) {
    return res.status(502).json({ error: 'Falha ao ler arquivo no GitHub', github_status: current.status });
  }

  // 2. Faz o commit
  const payload = {
    message: msg,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch: BRANCH,
    ...(sha ? { sha } : {}),
  };

  const put = await ghFetch(apiBase, token, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (put.status === 200 || put.status === 201) {
    return res.status(200).json({
      ok: true,
      path,
      commit: put.data.commit.sha,
      commit_url: put.data.commit.html_url,
    });
  }

  return res.status(put.status === 409 ? 409 : 502).json({
    error: put.status === 409
      ? 'Conflito: o arquivo mudou no GitHub após a leitura. Tente novamente.'
      : 'Falha ao gravar no GitHub',
    github_status: put.status,
    github_message: put.data && put.data.message,
  });
};
