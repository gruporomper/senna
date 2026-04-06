# Parte 6 — Infraestrutura (03-04/04/2026)

## 6.1 Docker (`e3e2651`)
**O que:** Infraestrutura Docker para servicos locais.
**Servicos containerizados:**
- Ollama (LLM local)
- Kokoro TTS (localhost:8880)
**Health check:** Endpoint `/api/health` verifica status de todos os servicos com timeout de 3s.
**Servicos verificados:** Ollama, Kokoro TTS, n8n

## 6.2 PWA — Progressive Web App (`4d29527`)
**O que:** SENNA funciona como app instalavel no celular/desktop.
**Componentes:**
- `manifest.json` — nome, icones, cores, display standalone
- Service Worker — cache de assets para funcionar offline
- Offline cache — paginas e scripts principais pre-cacheados
**Experiencia:** Usuario pode "instalar" SENNA como app nativo

## 6.3 n8n Automation (`580ce50`)
**O que:** Camada de automacao via n8n (workflow automation).
**Componentes:**
- Docker container n8n (localhost:5678)
- Endpoint `/api/automate` no server.js
- Fluxo de confirmacao antes de executar automacao
**Uso futuro:** Automacoes complexas (enviar email, criar tarefa no CRM, etc.)

## 6.4 Session Manager (`d1ac83e` → `3a56a2e`)
**O que:** Gerenciamento completo de sessoes de chat.

### Fase 1 (`d1ac83e`):
- SessionManager como objeto central
- Sidebar reestruturada com lista de sessoes
- Context menu (botao direito) em cada sessao

### Fase 2 (`f250bcc`):
- Drag-and-drop para reordenar sessoes
- Filtro por etiqueta
- Etiquetas customizaveis

### Fase 3 (`b12469f`):
- Integracao Google Drive para sessoes arquivadas
- Exportar sessao para Drive
- Importar sessao do Drive

### Fase 4 (`68f4ac4`):
- Auto-summary: resumo automatico da sessao ao fechar
- Context pack melhorado: contexto completo para continuar conversa
- Busca por etiqueta

### Etiquetas (`3a56a2e`):
- LabelStore para gerenciar etiquetas
- Picker com edicao inline (renomear, mudar cor)
- Etiquetas associadas a sessoes

## 6.5 Deploy

### VPS Deploy Script (`a9e3086`)
**O que:** Script bash para deploy via SSH.

### Auto-Deploy Webhook (`779c70d`, `8297990`)
**O que:** GitHub envia webhook no push → server.js executa deploy.
**Endpoint:** POST `/api/deploy`
**Seguranca:** Verificacao de assinatura HMAC do GitHub (`8297990`)
**Problema de seguranca:** Secrets hardcoded no script → removidos, usando template (`53c2013`)

### Deploy Script Template
**O que:** Template sem secrets, usuario preenche com valores reais.

## 6.6 Server.js — Endpoints

| Endpoint | Metodo | Funcao |
|----------|--------|--------|
| `/api/chat` | POST | Proxy para LLMs (streaming/non-streaming) |
| `/api/tts` | POST | Proxy para Kokoro TTS |
| `/api/stt/token` | POST | Token temporario para AssemblyAI |
| `/api/health` | GET | Health check de todos os servicos |
| `/api/deploy` | POST | Webhook de auto-deploy |
| `/api/automate` | POST | Automacoes n8n |
| `/*` | GET | Servir arquivos estaticos |

## 6.7 Supabase
**Uso:**
- Auth (login Google/email)
- Database (notes, tasks, memories)
- Restricao de dominio (@romper.global)
**CDN:** Fixado em v2.45.0 para estabilidade
**Sync:** Dual-write localStorage + Supabase

---

**Commits desta fase:** ~15 commits
**Periodo:** 03-04/04/2026
