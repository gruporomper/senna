# Parte 5 — Modulos Avancados (05/04/2026)

## 5.1 Os 6 Novos Modulos (`f090e39`)
**O que:** Expansao massiva — 6 sistemas adicionados ao SENNA de uma vez.
**Decisao:** Cada modulo e um objeto JS standalone em script.js com API propria.

### ProjectFlow (Projeto)
**Funcao:** Gerenciamento de projetos dentro do SENNA.
**Hierarquia:** Objetivo → Projeto → Etapa → Tarefa → Ideia
**Acesso:** Botao "Projeto" na sidebar
**Problema:** Hierarquia nao funcionava corretamente → corrigido em `eb75a57`

### SherlockDash (Sherlock)
**Funcao:** Dashboard de investigacao/analise com IA.
**Acesso:** Botao "Sherlock" na sidebar
**Uso:** Analises profundas usando callSherlockLLM()

### RadarManager (Radar)
**Funcao:** Monitoramento automatico de topicos/tendencias.
**Como funciona:**
1. Usuario configura topico + frequencia (ex: "IA no varejo", diario)
2. Scheduler verifica `nextRun <= now`
3. Executa prompt de analise de tendencias via callSherlockLLM()
4. Salva relatorio com titulo, sumario, data
5. Toast notifica sobre novos relatorios

**Configuracao:**
```javascript
{
  id: uuid, topic: string, frequency: 'diario'|'semanal',
  lastRun: timestamp, nextRun: timestamp, active: boolean
}
```

**UI (reescrita em `80b2419`):**
- Duas abas: Topicos | Relatorios
- Botao "Executar agora" por topico
- Relatorios com expand/collapse + marcar como lido
- Badge de nao-lidos no dashboard

**Execucao automatica:** No init(), apos 5s delay, roda `runDueRadars()`

### DiscoveryEngine (Descobertas)
**Funcao:** Gerar oportunidades/insights personalizados para o usuario.
**Como funciona:**
1. Coleta: SelfProfileManager.getSummary() + MemoryBank.getRecent(10) + CaptureStore.getActive()
2. Prompt pede 3-5 oportunidades relevantes ao perfil
3. Resposta em JSON: [{titulo, descricao, razao, tipo, prioridade}]
4. Salva com status 'new'

**UI (reescrita em `80b2419`):**
- Cards com icone, titulo, descricao, razao
- Filtros: Todas | Novas | Salvas
- Botoes: Salvar | Descartar | Saber mais
- Botao "Gerar descobertas" para execucao manual
- shouldRun(): executa automaticamente a cada 24h

### SelfProfileManager (Perfil)
**Funcao:** Perfil do usuario construido ao longo das conversas.
**Dados:** Nome, cargo, interesses, expertise, comportamento.
**Metodo principal:** `getSummary()` retorna resumo textual do perfil.
**Uso:** Injeta no system prompt + alimenta Descobertas

### RapportEngine (Rapport)
**Funcao:** Construcao de relacionamento com o usuario.
**Dados:** Tom preferido, estilo de comunicacao, frequencia de interacao.
**Uso:** Personaliza a forma como SENNA se comunica

## 5.2 Skills Engine (`4e55456`)
**O que:** Sistema de skills/habilidades que SENNA pode ativar.

### Skills Built-in (6):
1. **Analise de Dados** — interpreta planilhas, graficos, metricas
2. **Redacao** — textos profissionais, emails, documentos
3. **Codigo** — programacao, debug, refatoracao
4. **Pesquisa** — investigacao profunda com fontes
5. **Brainstorm** — geracao de ideias criativas
6. **Planejamento** — planos de acao, cronogramas

### Como funciona:
**Auto-deteccao:**
- Cada skill tem `triggers` (RegExp para built-in) ou `triggerStrings` (array de strings para custom)
- `SkillsEngine.detect(message)` roda antes de enviar ao LLM
- Se detectada, ativa automaticamente e injeta prompt especifico

**Ativacao manual:**
- Comando `/skill [nome]` — ativa skill especifica
- Mensagem "usa skill X" — pattern matching

**Prompt injection:**
- `buildPromptBlock()` gera bloco com todas skills disponiveis
- Skill ativa tem prompt adicional injetado no system prompt via `buildSystemPrompt()`

**Skills customizadas:**
- Usuario cria via modal com nome, descricao, prompt, triggers
- Salvas em localStorage via `SkillsEngine.addCustom()`
- `triggerStrings` (string[]) em vez de `triggers` (RegExp) para serializar em JSON

### UI — Modal de Skills (`openSkillsModal`):
- Grid de cards: built-in + custom
- Cada card mostra nome, descricao, status (ativa/inativa)
- Toggle para ativar/desativar
- Formulario para criar skill custom
- Deletar skills customizadas
- Badge acima do input quando skill ativa (`showSkillBadge()`)

### Wiring (integracao):
- `processCommand()` → `/skills` abre modal, `/skill [nome]` ativa
- `buildSystemPrompt()` → injeta bloco de skills
- `SYSTEM_PROMPT` → instrucoes sobre `[ACTION:open_skills]`
- `ACTION_HANDLERS` → `open_skills: () => openSkillsModal()`
- Profile menu → case 'skills' → openSkillsModal()
- Auto-detect hook antes da chamada LLM em processCommand()

## 5.3 Cockpit Estrategico (`250102d`)
**O que:** Auto-captura de insights durante conversas.
**CaptureStore:** Armazena insights, decisoes, tarefas capturadas automaticamente.
**Painel:** Organizacional com hierarquia de objetivos → projetos → etapas

## 5.4 Cockpit Hierarquico (`631931b`)
**O que:** Expansao do cockpit com 5 niveis.
**Niveis:** Objetivo → Projeto → Etapa → Tarefa → Ideia
**Navegacao:** Breadcrumb para subir/descer na hierarquia

## 5.5 Sync e Cleanup (`eb75a57`)
**O que:** Correcoes pos-lancamento dos modulos.
**Fixes:**
- Limpar cockpit ao trocar de modo
- Sync Supabase → localStorage (dados que existiam no cloud mas nao local)
- ProjectFlow hierarquia funcionando corretamente

---

**Commits desta fase:** 7 commits
**Periodo:** 05/04/2026
