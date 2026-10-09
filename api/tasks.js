# Dashboard Iconic: aba Tarefas e Atas

Especificação de comportamento. O código fica em `index.html` (seção "TAREFAS E ATAS") e `api/tasks.js`.

## Fonte de dados (Notion)

- **Tasks List** (`3b9ef5854ef380ec84e0d4cc4c8fe98a`): tarefas.
  - `Nome da tarefa` (título), `Status` (Backlog, To-Do, Waiting, On Going, Paused, Done), `Owner` (Parceiro, Hubii, Ambos), `Week` (número), `Companies` (relação), `Data`.
  - Histórico de atualizações = comentários da própria página.
- **Meeting Notes** (`2edef5854ef38038a9c7f59d73c1c6da`): atas. Somente leitura.
  - `Meeting` (título), `Date`, `Companies`.
- Filtro das duas bases: `Companies` contém a página Iconic (`34cef585-4ef3-806b-b4e9-cd67a2b3a07e`).
- Credencial: variável `NOTION_TOKEN` na Vercel. A integração precisa ler e inserir comentários.

## Aba Tarefas

### Regra principal

**Tarefas concluídas (`Done`) não aparecem na visão principal.** Uma atividade encerrada não é prioridade da semana. Elas só aparecem numa área própria de consulta ("Concluídas" / "Atividades Done"), acessada por drill-down.

### Visão principal (padrão)

- Mostra só tarefas com status diferente de `Done`.
- Agrupadas por `Week`, da semana mais recente para a mais antiga.
- Tarefas ativas sem `Week` ficam no grupo "Sem semana definida", no fim da lista.
- Barra de navegação por semana no topo: **Todas**, depois uma chip por semana com a contagem (ex.: S41 · 3), e "Sem semana". Clicar filtra a lista.
- Cada linha mostra: checkbox, nome, responsável (Iconic, Hubii ou Ambos) e o status.
- Clicar no checkbox alterna entre `Done` e `On Going`.
- Clicar na linha abre o modal com status, responsável, histórico e campo para nova atualização.

### Área de concluídas (drill-down)

- Fica abaixo da lista ativa, recolhida por padrão, com o rótulo "Concluídas" e a contagem.
- Ao expandir, agrupa as concluídas por semana, com a mesma navegação por semana.
- Tarefas `Done` sem semana aparecem aqui, no grupo "Sem semana definida", e não na visão principal.
- Esta área é só para consulta. Ela não precisa de ações além de abrir a tarefa.

### Ações

- Trocar status e responsável: `POST /api/tasks` com `action: update`.
- Nova atualização: `POST /api/tasks` com `action: comment`, gravada como comentário no Notion. O histórico é recarregado com `GET /api/tasks?comments=<id>`.
- Nova tarefa: `POST /api/tasks` com `action: create`. Cria a página na Tasks List já vinculada à Iconic.

## Aba Atas

- As **5 atas mais recentes** aparecem em cards, com um trecho do resumo.
- As demais ficam em "Anteriores", com duas visões que o usuário alterna:
  - **Por mês** (padrão): grupos como "setembro 2026", com o mais recente no topo.
  - **Por tipo de reunião**: o tipo é o título sem o número e sem o texto entre parênteses. Ex.: "Weekly [41]" e "Weekly [40]" entram no grupo "Weekly". Grupos ordenados pela quantidade de atas.
- Dentro de cada grupo, cada ata é recolhida. Ao expandir, o conteúdo é carregado sob demanda com `GET /api/tasks?ata=<id>`.
- Clicar num card recente abre o detalhe no modal, com o link "Abrir ata no Notion".
- Se o Notion não devolver texto, a ata mostra o aviso "não tem texto disponível aqui" e o link para o Notion.
- O conteúdo das atas fica em cache no servidor por 10 minutos.

## Estado atual vs. especificação

| Item | Implementado no código | Pendente |
|---|---|---|
| Barra de semanas | Sim | Verificar com dados reais |
| Concluídas fora da visão principal | **Não**: ainda aparecem na visão principal, no fim | Remover da visão principal e deixar só na área de concluídas |
| Concluídas agrupadas por semana | Sim, dentro da área recolhida | Nenhuma |
| Atas: 5 recentes + agrupamento por mês e por tipo | Sim | Verificar com dados reais |
| Conteúdo das atas | Depende de a API do Notion devolver o texto | Se não devolver, ver logs da Vercel (`ata sem texto`) e definir a fonte alternativa |

## Itens em aberto

1. **Week nas concluídas:** as tarefas `Done` estão sem `Week` no Notion. Como a área de concluídas agrupa por semana, elas vão aparecer em "Sem semana definida" até a coluna ser preenchida.
2. **Conteúdo das atas:** a API pública pode não expor o texto do bloco de reunião. Confirmar com o log `ata sem texto` e os tipos de bloco que aparecem nele.
3. **Deploy:** `api/tasks.js` precisa estar no GitHub junto com o `index.html`. Sem ele, o `Week` não chega à tela.
