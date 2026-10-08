// Vercel Serverless Function
// GET /api/resultados
//
// Busca ao vivo no Metabase (Redshift - Datalake) as perguntas da aba Resultados
// do projeto Iconic/IPIRANGA e devolve no formato compacto {c: colunas, r: linhas}.
//
// Variáveis de ambiente (Vercel → Settings → Environment Variables):
//   METABASE_URL                      ex.: https://bi.hubii.co
//   METABASE_API_KEY                  chave de API do Metabase (somente leitura)
//   METABASE_CARD_OPS_SEMANA          (opcional) ID da pergunta "Iconic-Hubs-Ops" (padrão: 3630)
//   METABASE_CARD_OPS_RECUSA_PRODUTO  (opcional) ID da pergunta "Iconic-Hubs-Recusas" (padrão: 3631)
//
// Se METABASE_URL/KEY não existirem, responde 503 e o dashboard usa o snapshot
// versionado em /resultados-data.json. As perguntas de Supply Ops são opcionais:
// sem os IDs (ou com erro nelas) o front usa o bloco "ops" do snapshot.

const CARDS = {
  mensal:  { id: 3609, cols: ['mes','gmv_valido','gmv_todos_status','gmv_cancelado','pedidos','unidades'] },
  produto: { id: 3610, cols: ['produto','gmv_valido','pct_gmv','pct_acumulado','unidades','pedidos_validos','hubs_que_venderam'] },
  da:      { id: 3611, cols: ['mes','da','gmv_valido','pedidos_validos','hubs_ativos','pct_gmv_no_periodo'] },
  hub:     { id: 3612, cols: ['hub_nome','cidade','uf','da','gmv_valido','pct_gmv','ticket_medio','transacoes','unidades','consumidores','mix_skus','cancelados','pct_cancelamento','recusas_ruptura','recusas_preco','recusas_fora_portfolio','primeira_compra','ultima_compra','intervalo_medio_dias','transacoes_por_semana','rank_geral'] },
  sla:     { id: 3613, cols: ['hub','da','pedidos','gmv_valido','gmv_cancelado','cancelados','pct_cancelamento','pct_aceite','pct_recusa','pct_ignorado','pct_no_prazo','min_medio_ate_aceite','min_medio_ate_despacho','recusas_ruptura','recusas_preco','recusas_fora_portfolio','broadcasts_recebidos','pct_reencaminhados'] },
};

// Contrato fechado das perguntas de Supply Ops (ordem e nomes não podem mudar)
const OPS_CARDS = {
  semana: {
    env: 'METABASE_CARD_OPS_SEMANA', defId: 3630,
    cols: ['semana','hub_id','hub_nome','uf','da','broadcasts_recebidos','respondidos','aceitos','recusados','ignorados','erros_pos_aceite',
           'pedidos_validos','gmv_valido','unidades','pedidos_cancelados','itens_ruptura','itens_qtd_insuficiente','itens_fora_portfolio','itens_preco','itens_outros',
           'min_medio_ate_aceite','min_medio_ate_despacho','pct_no_prazo'],
  },
  recusa_produto: {
    env: 'METABASE_CARD_OPS_RECUSA_PRODUTO', defId: 3631,
    cols: ['hub_id','hub_nome','uf','da','produto','motivo','itens_recusados','pedidos_afetados'],
  },
};

const clean = (v) => {
  if (typeof v === 'number') return Math.round(v * 100) / 100;
  if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v)) return v.slice(0, 10);
  return v === undefined ? null : v;
};

// Tolerante a valores colados com espaços, aspas ou em formato de link markdown.
const cleanEnv = (v) => String(v || '').trim().replace(/^["']+|["']+$/g, '').trim();
const cleanUrl = (v) => {
  const raw = cleanEnv(v);
  const m = raw.match(/https?:\/\/[^\s)\]"']+/i);
  const url = m ? m[0] : (raw ? 'https://' + raw.replace(/^\/+/, '') : '');
  // a API do Metabase fica na raiz do domínio: ignora caminhos colados (ex.: /collection/175-...)
  try { return new URL(url).origin; } catch (e) { return url.replace(/\/+$/, ''); }
};

async function fetchCard(base, key, id, cols) {
  const r = await fetch(`${base}/api/card/${id}/query/json`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'x-api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: '{}',
  });
  const text = await r.text();
  let rows;
  try { rows = JSON.parse(text); } catch (e) { rows = null; }
  if (!r.ok || !Array.isArray(rows)) {
    const loc = r.headers.get('location');
    throw new Error(
      `card ${id} (${base}): HTTP ${r.status}, content-type ${r.headers.get('content-type') || '-'}` +
      (loc ? `, location ${loc}` : '') + `, corpo(${text.length}): ${text.slice(0, 160).replace(/\s+/g, ' ')}`
    );
  }
  return { c: cols, r: rows.map((o) => cols.map((k) => clean(o[k]))) };
}

module.exports = async function handler(req, res) {
  const base = cleanUrl(process.env.METABASE_URL);
  const key = cleanEnv(process.env.METABASE_API_KEY);

  if (!base || !key) {
    return res.status(503).json({ error: 'METABASE_URL / METABASE_API_KEY não configurados' });
  }

  try {
    const out = {};
    await Promise.all(Object.entries(CARDS).map(async ([name, { id, cols }]) => {
      out[name] = await fetchCard(base, key, id, cols);
    }));

    // Supply Ops (opcional): falha aqui não derruba a aba; cada pergunta falha de forma independente
    const idOf = (o) => parseInt(cleanEnv(process.env[o.env]), 10) || o.defId;
    const [sem, rec] = await Promise.allSettled([
      fetchCard(base, key, idOf(OPS_CARDS.semana), OPS_CARDS.semana.cols),
      fetchCard(base, key, idOf(OPS_CARDS.recusa_produto), OPS_CARDS.recusa_produto.cols),
    ]);
    const errs = [sem, rec].filter((x) => x.status === 'rejected').map((x) => x.reason.message);
    if (errs.length) { console.error('[resultados] ops', errs.join(' | ')); out.opsError = errs.join(' | '); }
    if (sem.status === 'fulfilled' || rec.status === 'fulfilled') {
      out.ops = {
        live: true,
        ref: new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10),
        semana: sem.status === 'fulfilled' ? sem.value : { c: OPS_CARDS.semana.cols, r: [] },
        recusa_produto: rec.status === 'fulfilled' ? rec.value : { c: OPS_CARDS.recusa_produto.cols, r: [] },
      };
    }

    out.refreshedAt = new Date().toISOString();
    // cache só no navegador (dado de cliente atrás de senha): evita bater no Redshift a cada clique
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.status(200).json(out);
  } catch (err) {
    console.error('[resultados] exception', err.message);
    return res.status(502).json({ error: err.message });
  }
};
