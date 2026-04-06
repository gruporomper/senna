# Parte 4 — Inteligencia (03/04/2026)

## 4.1 Multi-LLM Router (`b5bcf24`)
**O que:** Roteamento inteligente entre multiplos provedores de IA.
**Provedores suportados:** OpenAI, Anthropic (Claude), Grok, Ollama (local), Groq
**Como funciona:**
1. Analisa complexidade da mensagem (simples/media/complexa)
2. Seleciona provider baseado em custo/capacidade
3. Se falhar → fallback chain automatico
4. Tracking de custo por requisicao

**Roteamento de complexidade:**
- Simples (saudacao, pergunta direta) → modelo menor/mais barato
- Media (analise, criacao) → modelo intermediario
- Complexa (codigo, pesquisa, multi-etapa) → modelo mais capaz

**Prefixos manuais de modelo:**
O usuario pode forcar um provider com prefixo na mensagem:
- `!gpt` → OpenAI
- `!claude` → Anthropic
- `!grok` → xAI
- `!ollama` → local
- `!groq` → Groq

## 4.2 Streaming SSE (`8d4916c`)
**O que:** Respostas token-por-token em tempo real.
**Protocolo:** Server-Sent Events (SSE) via `/api/chat` com `stream: true`
**Fluxo:**
1. Frontend envia POST com `stream: true`
2. Server abre conexao SSE com provider
3. Cada token chega como evento `data: {...}`
4. Frontend renderiza incrementalmente
5. Markdown e processado em tempo real
**Fallback:** Se streaming falhar, tenta resposta completa (non-stream)

## 4.3 SENNA Memory Engine (`e61e924`)
**O que:** Sistema de memoria baseado em fatos extraidos das conversas.
**Componentes:**
- **MemoryBank:** Armazena fatos como objetos `{fact, source, timestamp, confidence}`
- **Extracao automatica:** Ao final de cada conversa, extrai fatos relevantes
- **Deduplicacao:** Evita memorias duplicadas comparando similaridade
- **Retrieval:** Na hora de responder, busca memorias relevantes ao contexto
- **Integracao com prompt:** Memorias sao injetadas no system prompt como contexto

**Armazenamento:**
- localStorage (primario, offline)
- Supabase (sync, persistencia em nuvem)
- Dual-write: salva em ambos simultaneamente

## 4.4 Budget Guards (`b99ff02`)
**O que:** Controle de custos de API.
**Funcionalidades:**
- Limite diario configuravel (padrao em settings)
- Modal de confirmacao quando se aproxima do limite
- Toast de aviso ao ultrapassar threshold
- Tracking de custo por mensagem (campo `cost` na resposta do router)

## 4.5 System Prompt Estruturado
**Evolucao:**
1. Prompt basico com instrucoes de consultor proativo (`f1c12de`)
2. Protocolo de analise em 4 passos (`1f8c027`)
3. Perfil adaptativo para diferentes usuarios (`40681a8`)
4. Integracao com MemoryBank — memorias injetadas (`e61e924`)
5. Integracao com Skills — bloco de skills ativas (`4e55456`)
6. Self-Actions — tags inline para acoes automaticas (`753b667`)

**Funcao `buildSystemPrompt()`:**
Monta prompt dinamicamente combinando:
- Base do SENNA (identidade, regras)
- Memorias relevantes do MemoryBank
- Perfil do usuario (SelfProfileManager)
- Skills ativas (SkillsEngine)
- Contexto da sessao (captures do CockpitManager)

## 4.6 callSherlockLLM() — Chamada Non-Streaming
**O que:** Funcao utilitaria para chamadas LLM sem streaming.
**Uso:** Radar, Descobertas, analises internas onde nao precisa mostrar token-por-token.
**Implementacao:** POST `/api/chat` com `stream: false`, `forceProvider: 'openai'`
**Retorno:** Texto completo da resposta

## 4.7 Self-Actions — Function Calling Inline (`753b667`)
**O que:** SENNA pode executar acoes durante a conversa via tags inline.
**Como funciona:**
1. System prompt instrui SENNA a incluir tags `[ACTION:nome]` na resposta
2. Frontend detecta e executa a acao correspondente
3. ACTION_HANDLERS mapeia nome → funcao

**Acoes disponiveis:**
- `[ACTION:save_memory]` — salvar memoria
- `[ACTION:create_task]` — criar tarefa
- `[ACTION:open_skills]` — abrir modal de skills
- `[ACTION:open_settings]` — abrir configuracoes
- Extensivel — novos handlers sao adicionados ao objeto ACTION_HANDLERS

## 4.8 Supabase Data Layer (`d155c5d`)
**O que:** Camada de dados com Supabase como backend.
**Tabelas:**
- Notes (notas/anotacoes)
- Tasks (tarefas)
- Memories (memorias do MemoryBank)
**Sync:** Dual-write — localStorage + Supabase simultaneamente
**Offline:** Funciona sem internet via localStorage, sincroniza quando reconecta

---

**Commits desta fase:** ~8 commits
**Periodo:** 03/04/2026
