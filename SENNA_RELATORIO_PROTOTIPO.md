# SENNA v2.0 - Relatorio Completo do Prototipo

**Data**: 05/04/2026
**Projeto**: SENNA - Assistente de IA pessoal sem limites
**Dono**: Marlon Rihayem (Grupo Romper)
**Status**: Prototipo funcional (127 commits)
**Stack**: Vanilla JS + Node.js + Supabase + Multi-LLM
**Total de codigo**: ~13.500 linhas

---

## 1. VISAO GERAL

SENNA e um assistente de IA pessoal construido para Marlon Rihayem, empresario brasileiro no Paraguai. O sistema foi projetado como prototipo rapido para validar conceitos antes de um rebuild completo.

**Principios do prototipo:**
- Voice-first: falar com o SENNA como se fosse um parceiro
- Memoria persistente: nunca esquecer o que foi dito
- Multi-LLM: usar o melhor modelo para cada situacao
- Organizacao automatica: capturar ideias/tarefas sem pedir
- Custo controlado: nunca estourar orcamento de API

---

## 2. ARQUITETURA

```
Browser (PWA)
  |
  +-- script.js (5.254 linhas) ---- UI, sessoes, cockpit, dashboard
  +-- voice-engine.js (1.296 linhas) -- STT/TTS/VAD/barge-in
  +-- auth.js / login.js ------------- Supabase Auth (Google OAuth + magic link)
  |
  v
Node.js Server (server.js - 1.035 linhas)
  |
  +-- llm-router.js (452 linhas) ----- Roteamento multi-LLM com fallback
  +-- memory-engine.js (795 linhas) --- Extracao de fatos + memoria persistente
  |
  v
Infraestrutura
  +-- Supabase (PostgreSQL) ----------- Auth, notas, tarefas, memorias, capturas, custos
  +-- Docker: Ollama (LLM local) ------ dolphin-mistral:7b, phi3:mini
  +-- Docker: Kokoro (TTS local) ------ Voz pm_alex, WAV
  +-- Docker: n8n (automacao) --------- Workflows + webhooks
```

---

## 3. FEATURES IMPLEMENTADAS

### 3.1 Chat Multi-Modal

**O que faz:** Conversa por texto ou voz com streaming token-a-token via SSE.

**Dois modos:**
- **Box (Home)**: conversa perpetua, sempre ativa, estilo walkie-talkie
- **Sessao**: conversa focada com titulo, objetivo, historico salvo

**Decisoes de design:**
- SSE (Server-Sent Events) ao inves de WebSocket — mais simples, funciona com proxy
- Streaming token-a-token para UX responsiva
- Markdown rendering em tempo real (code blocks, listas, bold)
- Acoes por mensagem: copiar, ler em voz alta, salvar como nota/tarefa, retry, branch

**O que funcionou:** Streaming e responsivo e natural. Box mode e intuitivo.
**O que melhorar:** Sessoes ficam pesadas em localStorage. Historico deveria estar 100% no Supabase.

---

### 3.2 Roteamento Multi-LLM

**O que faz:** Envia mensagens para o melhor LLM disponivel baseado em custo, complexidade e disponibilidade.

**Provedores configurados:**

| Provedor | Modelos | Custo (1M tokens in/out) | Uso |
|----------|---------|--------------------------|-----|
| Grok (X.AI) | grok-3-mini-fast, grok-3 | $0.10/$0.25 (mini), $0.30/$1.00 | Default, rapido |
| Gemini | gemini-2.0-flash, gemini-2.5-pro | FREE (flash), $1.25/$5.00 (pro) | Fallback gratis |
| OpenAI | gpt-4o-mini, gpt-4o | $0.15/$0.60, $2.50/$10.00 | Qualidade alta |
| Claude | haiku-4-5, sonnet-4-6 | $0.80/$4.00, $3.00/$15.00 | Tarefas criticas |
| Ollama | dolphin-mistral:7b | FREE (local) | Offline/privado |

**Logica de roteamento:**
1. Se usuario forcou provedor → usa esse
2. Se orcamento estourou → forca modelo gratis (Gemini flash)
3. Classificacao de complexidade: simple → modelo barato, critical → modelo capaz
4. Fallback chain: provedor preferido → gratis → mais barato disponivel

**Decisoes de design:**
- Tabela de precos inline no codigo (nao depende de API externa)
- Cada provedor tem seu proprio adapter (OpenAI format → Gemini format, etc.)
- Custo estimado ANTES da chamada, confirmacao se > $0.10

**O que funcionou:** Roteamento automatico e transparente. Custo controlado.
**O que melhorar:** Classificacao de complexidade e rudimentar (regex). Deveria usar embedding ou modelo leve. Falta metricas de qualidade por provedor.

---

### 3.3 Sistema de Voz

**O que faz:** Conversa por voz com deteccao de atividade, transcricao, sintese de fala e interrupcao.

**Pipeline:**
```
Microfone → AudioWorklet (VAD) → AssemblyAI (STT) → LLM → Kokoro (TTS) → Alto-falante
                                      |                        |
                                Web Speech API           ElevenLabs
                                 (fallback)              (fallback)
```

**Componentes:**

| Componente | Tecnologia | Funcao |
|------------|-----------|--------|
| VAD | AudioWorklet customizado | Detecta quando usuario fala/para |
| STT (primario) | AssemblyAI WebSocket | Transcricao em tempo real, pt-BR |
| STT (fallback) | Web Speech API | Funciona offline, sem custo |
| TTS (primario) | Kokoro (Docker local) | Voz pm_alex, WAV, baixa latencia |
| TTS (fallback) | ElevenLabs | Vozes premium, cloud |
| Barge-in | AudioContext | Interrompe TTS quando usuario fala |

**Estados da maquina:**
```
IDLE → LISTENING → THINKING → SPEAKING → LISTENING (loop)
                                  ↓
                              IDLE (se timeout)
```

**Controles de midia (Box mode):**
- Play/Pause
- Velocidade (0.5x a 2x)
- Volume (0-100%)
- Mic toggle
- Stop (encerra sessao de voz)

**Decisoes de design:**
- AudioWorklet ao inves de ScriptProcessorNode (melhor performance)
- Fila de TTS com 2 chunks em paralelo (pre-fetch enquanto primeiro toca)
- Barge-in com cooldown de 100ms
- Animacao do helmet sincronizada com audio (analyser FFT)

**O que funcionou:** Web Speech API como fallback e excelente. Barge-in funciona bem.
**O que melhorar:** AssemblyAI tem latencia alta (~2s). Kokoro local precisa GPU pra ser rapido. Falta Whisper como alternativa STT. VAD as vezes detecta ruido ambiente.

---

### 3.4 Sistema de Memoria

**O que faz:** Extrai fatos das conversas e armazena para uso futuro. SENNA "lembra" de preferencias, decisoes e contexto.

**Tipos de memoria:**
- `profile` — Dados do usuario (nome, idade, cargo)
- `preference` — Preferencias (horarios, estilo, comida)
- `operational` — Fatos de negocio (metricas, processos)
- `relationship` — Conexoes entre entidades
- `constraint` — Limitacoes e regras
- `behavioral` — Padroes de comportamento

**Pipeline de extracao:**
```
Conversa finaliza
       ↓
extractFacts() via grok-3-mini-fast
       ↓
resolveMemoryAction() — CREATE, UPDATE, IGNORE, NOOP
       ↓
MemoryWriteQueue (batch async, max 3 retries)
       ↓
Supabase: senna_memories + senna_memory_history
```

**Deduplicacao:**
- Hash normalizado do texto
- Similaridade: >90% = identico (IGNORE), >75% = evolucao (UPDATE)
- Pseudo-embeddings de 384 dimensoes para busca semantica

**Injecao no prompt:**
- `retrieveContext()` busca memorias relevantes (max 8000 chars)
- `buildSystemPrompt()` injeta memorias recentes + capturas ativas

**Decisoes de design:**
- Fila assincrona para nao bloquear resposta
- Confidence threshold de 0.50 para filtrar fatos fracos
- Audit trail completo (history table)
- LGPD: endpoint de purge total

**O que funcionou:** Extracao automatica funciona bem para fatos simples.
**O que melhorar:** Pseudo-embeddings sao imprecisos. Deveria usar embeddings reais (OpenAI/Voyage). Fatos se acumulam sem limpeza automatica. Falta consolidacao periodica.

---

### 3.5 Gerenciamento de Sessoes

**O que faz:** Cada conversa e uma sessao com titulo, objetivo, etiquetas, historico e metadados.

**Estrutura de uma sessao:**
```javascript
{
  id: UUID,
  title: "Nome da sessao",
  objective: "O que queremos resolver",
  messages: [{ role, content }],
  labels: [{ name, color }],
  pinned: boolean,
  summary: "Resumo auto-gerado",
  driveFileId: "id no Google Drive (se arquivada)",
  metadata: { tokens, provider, model, cost }
}
```

**Features:**
- Criar, renomear, fixar, etiquetar, arquivar, deletar
- Drag-and-drop para reordenar sessoes fixadas
- Busca por texto e por etiqueta
- Auto-resumo via LLM quando sessao e arquivada
- Context pack: extrai fatos + decisoes + pendencias para continuacao
- Arquivamento no Google Drive (OAuth com scope drive.file)

**Sistema de etiquetas (LabelStore):**
- Presets: cinza, vermelho, laranja, verde, azul, roxo, rosa
- Etiquetas customizaveis: nome + cor editaveis inline
- Propagacao: editar/remover etiqueta atualiza todas as sessoes

**Decisoes de design:**
- localStorage primeiro, Supabase async (offline-first)
- UUID gerado no client para evitar conflitos
- Sidebar com lista + context menu (right-click)

**O que funcionou:** Sessoes com etiquetas e pins sao uteis. Auto-summary e valioso.
**O que melhorar:** localStorage tem limite de 5-10MB. Sessoes grandes (>100 msgs) ficam lentas. Deveria paginar historico. Google Drive integration incompleta (OAuth em modo teste).

---

### 3.6 Cockpit Estrategico

**O que faz:** Sistema hierarquico de organizacao que captura automaticamente ideias, tarefas, metas e projetos da conversa.

**Hierarquia (5 tipos):**
```
Objetivo (resultado final com prazo)
  └─ Projeto (corpo de trabalho)
       └─ Etapa (fase/milestone)
            └─ Tarefa (acao concreta)

Ideia (conceito nao acionavel)
```

**Auto-captura:**
```
Usuario fala no Box/Sessao
       ↓
LLM responde (streaming)
       ↓
Server classifica via grok-3-mini-fast (async, nao bloqueia)
       ↓
Captures enviadas via SSE (segundo evento apos done:true)
       ↓
Client recebe → CaptureStore.addBatch() → toast "Capturei: Tarefa"
       ↓
Cockpit mostra tudo organizado
```

**CaptureStore (client-side):**
- `add(capture)` / `addBatch(captures)` — dual-write localStorage + Supabase
- `getChildren(parentId)` — busca filhos (drill-down)
- `getProgress(id)` — calcula % de filhos concluidos
- `getAncestors(id)` — breadcrumb de navegacao
- Migracao automatica de tipos antigos (goal→objective, strategy→project)

**UI do Cockpit:**
- Filtros por tipo: Tudo | Objetivos | Projetos | Etapas | Tarefas | Ideias
- Abas de status: Abertas | Em Andamento | Concluidas | Arquivo
- Cards com: badge colorido, prioridade, deadline, barra de progresso, acoes
- Drill-down: clicar num Objetivo → ver Projetos → Etapas → Tarefas
- Breadcrumb de navegacao

**Tabela Supabase (senna_captures):**
```sql
id UUID, user_id UUID, type TEXT, title TEXT, body TEXT,
status TEXT, priority TEXT, deadline TIMESTAMPTZ, tags TEXT[],
source_session_id TEXT, source_mode TEXT, parent_id UUID,
progress INTEGER, created_at, updated_at
```

**Decisoes de design:**
- Classificacao server-side para nao expor API keys no browser
- Stream fecha imediatamente apos done:true (classificacao roda em background)
- Progresso calculado automaticamente pela % de filhos concluidos
- Sistema prompt injeta capturas ativas para SENNA referenciar naturalmente

**O que funcionou:** Auto-captura e natural e nao interrompe o fluxo. Hierarquia faz sentido.
**O que melhorar:** Classificacao de tipo nem sempre e precisa (confunde tarefa com etapa). Falta arrastar itens entre pais. Falta edicao inline de titulo/body. Falta vincular captura a sessao de origem.

---

### 3.7 Dashboard (Home)

**O que faz:** Painel de widgets na tela inicial com informacoes uteis.

**Widgets:**
| Widget | Dados | Fonte |
|--------|-------|-------|
| Relogio | Hora + data por extenso | JavaScript Date |
| Clima | Temperatura + cidade | API externa |
| Tarefas | Pendentes (count + lista) | localStorage |
| Agenda | Proximo compromisso | Google Calendar (futuro) |
| Sessoes | Contagem ativas | SessionManager |
| Notas | Recentes | SennaDB |
| Cockpit | Capturas ativas (count + mini-lista) | CaptureStore |
| Custos | Gasto mensal de API | Supabase senna_api_costs |

**Decisoes de design:**
- Grid responsivo (adapta mobile/desktop)
- Widgets clicaveis (cockpit abre cockpit, etc.)
- Dados carregados no init e atualizados por eventos

**O que funcionou:** Visao rapida do estado geral.
**O que melhorar:** Widget de agenda nao funciona ainda. Clima e generico. Falta customizacao (quais widgets mostrar).

---

### 3.8 Controle de Custos

**O que faz:** Rastreia gastos com APIs de LLM e impoe limites.

**Limites (configuraveis via .env):**
- Diario soft: $2.00 (warning)
- Diario hard: $5.00 (bloqueia)
- Mensal soft: $30.00 (warning)
- Mensal hard: $45.00 (bloqueia)
- Por chamada: confirma se > $0.10

**Fluxo:**
1. Antes da chamada: estima custo baseado em tokens
2. Se custo alto: modal de confirmacao
3. Apos resposta: loga custo real no Supabase
4. Cache de 60s para evitar queries excessivas
5. Se orcamento estourado: forca modelo gratis (Gemini flash)

**Widget no dashboard:** Mostra gasto mensal em tempo real.

**Decisoes de design:**
- Estimativa pre-chamada para evitar surpresas
- Cache agressivo (60s) para reduzir load no Supabase
- Downgrade automatico ao inves de bloquear completamente

**O que funcionou:** Controle de custo evita surpresas. Modal de confirmacao e util.
**O que melhorar:** Estimativa de tokens e imprecisa (conta chars, nao tokens reais). Falta grafico de evolucao de custo. Falta alerta por email quando se aproxima do limite.

---

### 3.9 Autenticacao

**O que faz:** Login via Google OAuth ou magic link por email.

**Fluxo:**
1. Pagina de login (login.html) com animacao de particulas
2. Google OAuth (escopo: drive.file para integracao Drive)
3. Ou: email magic link (OTP via Supabase)
4. Whitelist: apenas `marlon@romper.global`
5. Guarda de auth (auth.js) verifica sessao em toda pagina

**Decisoes de design:**
- Whitelist hardcoded para fase de prototipo
- Google OAuth com escopo de Drive (para arquivar sessoes)
- Supabase Auth gerencia sessoes/tokens

**O que funcionou:** Simples e funcional.
**O que melhorar:** Whitelist nao escala. Precisa de sistema de convites. OAuth do Google Drive esta em modo teste (erro de troca de codigo).

---

### 3.10 PWA e Offline

**O que faz:** Funciona como app instalavel com suporte offline basico.

**Service Worker (sw.js):**
- Cache-first para assets estaticos (HTML, CSS, JS, imagens)
- Network-first para APIs (/api/*)
- Fallback: serve index.html se offline

**Manifest:** Nome "SENNA - Assistente IA", icone do capacete, standalone mode.

**O que funcionou:** Instala como app no celular/desktop.
**O que melhorar:** Offline real precisa de queue de mensagens + sync quando voltar online. Push notifications para capturas/lembretes.

---

### 3.11 Deploy e CI/CD

**O que faz:** Auto-deploy via GitHub webhook.

**Fluxo:**
1. Push para repositorio
2. GitHub envia webhook para /api/deploy
3. Server verifica assinatura HMAC-SHA256
4. Executa: git pull + restart

**Infraestrutura:**
- VPS com Docker (Ollama + Kokoro + n8n)
- Nginx como reverse proxy
- Node.js rodando na porta 3000

**O que funcionou:** Deploy automatico funciona bem.
**O que melhorar:** Falta CI (testes automaticos antes do deploy). Falta rollback automatico. Falta healthcheck pos-deploy.

---

## 4. BANCO DE DADOS (SUPABASE)

### Tabelas principais:

| Tabela | Funcao | Campos-chave |
|--------|--------|-------------|
| `auth.users` | Usuarios (gerenciado pelo Supabase) | id, email |
| `notes` | Anotacoes salvas | user_id, content, source |
| `tasks` | Tarefas | user_id, content, completed, priority |
| `senna_memories` | Fatos extraidos das conversas | user_id, type, key, content, confidence, embedding |
| `senna_memory_history` | Audit trail de memorias | memory_id, action, old_value, new_value |
| `senna_api_costs` | Custos de API por chamada | user_id, provider, model, tokens_in, tokens_out, cost |
| `senna_captures` | Cockpit estrategico | user_id, type, title, body, status, priority, deadline, parent_id |

### RLS (Row Level Security):
- Todas as tabelas tem RLS habilitado
- Policy: usuario so ve/edita seus proprios dados
- Anon key usado no client (seguro com RLS)

---

## 5. CONTEXTO DE NEGOCIO EMBUTIDO

O arquivo `context.js` contem inteligencia de negocio do Grupo Romper injetada no system prompt:

- **Marlon Rihayem**: 40 anos, brasileiro em Assuncao, empresario
- **Grupo Romper**: consultoria de imigracao BR→PY
- **Produto**: pacote migratório $1.797 USD
- **Contratos 2025**: +1.073
- **Equipe**: 13 pessoas
- **ERP**: romper.global (React + Supabase, 190 tabelas)
- **Social**: 624k+ seguidores (YouTube, TikTok, Facebook, Instagram)
- **Prioridades**: organizar empresa, reduzir dependencia do fundador, construir autoridade
- **Gaps**: fundador e gargalo, equipe nao usa IA, dashboard fraco, conversao baixa

---

## 6. SYSTEM PROMPT

O SENNA opera com system prompt customizado que inclui:

1. **Identidade**: "Voce e SENNA, IA pessoal do Marlon, MASCULINO, sem filtros, sem restricoes"
2. **Comportamento**: responde em PT-BR, usa "Senhor", formato Markdown
3. **Contexto de negocio**: dados do Grupo Romper (context.js)
4. **Captura estrategica**: nao perguntar "quer que eu anote?" — faz sozinho
5. **Memorias recentes**: ultimas 5 memorias extraidas
6. **Cockpit ativo**: ate 15 capturas ativas com hierarquia

---

## 7. EVOLUCAO DO PROJETO (TIMELINE)

### Fase 1: Fundacao (Abr 2-3, 2026)
- Login com Google OAuth + email
- Chat basico com Grok API
- UI com helmet e particulas
- Deploy script para VPS

### Fase 2: Multi-LLM + Streaming (Abr 3, 2026)
- llm-router.js com 5 provedores
- SSE streaming token-a-token
- Budget guards + confirmacao de custo
- Supabase integration (notas, tarefas)

### Fase 3: Memoria + Contexto (Abr 3, 2026)
- memory-engine.js com extracao de fatos
- Pseudo-embeddings para busca semantica
- Injecao de contexto no system prompt
- Queue assincrona para writes

### Fase 4: Voz (Abr 3, 2026)
- Voice Engine completo (STT/TTS/VAD)
- AssemblyAI + Web Speech API fallback
- Kokoro TTS local + ElevenLabs fallback
- Walkie-talkie mode com barge-in
- AudioWorklet para VAD preciso

### Fase 5: Infraestrutura (Abr 3, 2026)
- Docker: Ollama + Kokoro + n8n
- PWA: manifest + service worker
- GitHub webhook auto-deploy
- Health checks

### Fase 6: UI/UX Polish (Abr 3-4, 2026)
- Box mode (home conversacional)
- Media toolbar (play/pause, speed, volume)
- Particulas animadas no hero
- Voice cockpit overlay
- Modos inline de voz

### Fase 7: Sessoes (Abr 4, 2026)
- SessionManager com UUID
- Sidebar reestruturada + context menu
- Drag-and-drop + etiquetas coloridas
- Google Drive archival
- Auto-summary + context pack
- Busca por texto e etiqueta

### Fase 8: Cockpit Estrategico (Abr 4-5, 2026)
- CaptureStore com auto-captura via LLM
- 6 tipos planos → 5 tipos hierarquicos (Objetivo/Projeto/Etapa/Tarefa/Ideia)
- Drill-down com breadcrumb
- Barra de progresso automatica
- Dashboard widget
- Fix TTS bloqueado por captures (stream break on done:true)

---

## 8. PROBLEMAS CONHECIDOS

| Problema | Severidade | Contexto |
|----------|-----------|----------|
| Google Drive OAuth em modo teste | Media | Coworker habilitou API mas consent screen esta em "Testing" |
| localStorage limite de 5-10MB | Alta | Sessoes grandes podem estourar storage |
| AssemblyAI latencia ~2s | Media | STT demora pra transcrever, Web Speech e mais rapido |
| Classificacao de tipo imprecisa | Media | LLM confunde tarefa com etapa as vezes |
| Kokoro TTS precisa GPU | Baixa | CPU funciona mas e lento |
| Pseudo-embeddings imprecisos | Media | Busca semantica deveria usar embeddings reais |
| Fatos se acumulam sem limpeza | Baixa | Precisa consolidacao periodica |
| Widget de agenda nao funciona | Baixa | Precisa integracao com Google Calendar |

---

## 9. LICOES APRENDIDAS

### O que funcionou bem:
1. **Vanilla JS**: sem framework = rapido para prototipar, sem overhead
2. **SSE streaming**: simples, funciona com proxy, boa UX
3. **Dual-write (localStorage + Supabase)**: offline-first resiliente
4. **Multi-LLM router**: flexibilidade para trocar provedores
5. **Auto-captura**: natural, nao interrompe conversa
6. **Web Speech API como fallback**: funciona sem dependencia externa

### O que NAO funcionou:
1. **Tudo num script.js de 5.000+ linhas**: impossivel de manter
2. **Pseudo-embeddings**: imprecisos para busca semantica real
3. **6 tipos de captura planos**: confuso para o usuario, hierarquia e melhor
4. **localStorage para sessoes longas**: limite de storage, sem paginacao
5. **AudioWorklet + AssemblyAI**: complexo demais, Web Speech resolve 80% dos casos

### Recomendacoes para o projeto final:
1. **Framework frontend**: Next.js ou SvelteKit para modularidade
2. **Embeddings reais**: OpenAI text-embedding-3-small ou Voyage
3. **Database-first**: tudo no Supabase, localStorage so como cache
4. **Whisper local**: para STT rapido e privado
5. **Separar concerns**: modulos por feature (chat, voice, cockpit, memory)
6. **Testes**: zero testes no prototipo — projeto final precisa de suite completa
7. **TypeScript**: evita bugs que Vanilla JS permite
8. **Componentizacao**: cada widget/card/modal como componente isolado
9. **WebSocket**: para eventos real-time (capturas, notificacoes, sync)
10. **Queue robusta**: BullMQ ou similar para jobs async (memoria, capturas, resumos)

---

## 10. ARQUIVOS DO PROJETO

| Arquivo | Linhas | Funcao |
|---------|--------|--------|
| script.js | 5.254 | Logica principal do app (UI, sessoes, cockpit, dashboard) |
| voice-engine.js | 1.296 | Pipeline de voz (STT/TTS/VAD/barge-in) |
| server.js | 1.035 | Servidor HTTP + APIs + streaming |
| memory-engine.js | 795 | Extracao de fatos + memoria persistente |
| llm-router.js | 452 | Roteamento multi-LLM com fallback |
| style.css | 3.600+ | Estilos completos (Orbitron + Inter) |
| index.html | 580 | Estrutura da UI |
| login.html | ~100 | Pagina de login |
| login.js | 167 | Logica de autenticacao |
| context.js | 76 | Contexto de negocio do Grupo Romper |
| auth.js | 61 | Guard de autenticacao |
| sw.js | ~50 | Service Worker (offline) |
| docker-compose.yml | ~60 | Docker: Ollama + Kokoro + n8n |
| audio-processor.worklet.js | 44 | AudioWorklet para VAD |
| manifest.json | ~20 | Configuracao PWA |

---

## 11. VARIAVEIS DE AMBIENTE

```env
PORT=3000

# LLM APIs
GROK_API_KEY=
GEMINI_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=

# STT
ASSEMBLYAI_API_KEY=

# TTS
KOKORO_URL=http://localhost:8880
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=

# LLM Local
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=dolphin-mistral:7b

# Database
SUPABASE_URL=
SUPABASE_ANON_KEY=

# Automacao
N8N_WEBHOOK_URL=http://localhost:5678/webhook
N8N_USER=admin
N8N_PASSWORD=

# Custos
DAILY_BUDGET=2.00
MONTHLY_BUDGET=30.00
COST_ALERT_THRESHOLD=10

# Deploy
DEPLOY_SECRET=
```

---

## 12. PROXIMO PASSO: PROJETO FINAL

Este prototipo validou os conceitos centrais. O projeto final deve:

1. **Comecar do zero** com arquitetura modular (framework + TypeScript)
2. **Preservar** as features validadas: multi-LLM, voz, memoria, cockpit hierarquico, auto-captura
3. **Resolver** os problemas conhecidos: storage, embeddings, testes, componentizacao
4. **Adicionar** o que faltou: function calling (SENNA executar acoes nele mesmo), notificacoes, agenda real, multi-usuario
5. **Usar este documento** como referencia do que foi construido, testado e aprendido

---

*Documento gerado em 05/04/2026 por Claude Opus 4.6 baseado na analise completa do repositorio senna-jarvis (127 commits, ~13.500 linhas de codigo).*
