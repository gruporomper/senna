# Parte 8 — Ideias, Visao Futura e Decisoes Pendentes

## 8.1 MCP Connector — SENNA ↔ Claude
**Discutido em:** Sessao de 05/04/2026
**O que e:** Model Context Protocol — padrao aberto para conectar IAs a ferramentas externas.

### SENNA como Tool Provider para Claude:
Se SENNA expor um servidor MCP, Claude (Desktop/API) pode:
- Consultar memorias do SENNA ("o que eu disse sobre X?")
- Ler relatorios do Radar
- Acessar dados do CRM/projetos
- Buscar sessoes anteriores por contexto
- Executar acoes no SENNA (criar tarefa, agendar radar)

### SENNA chamando Claude:
Via Anthropic API, SENNA pode:
- Usar Claude como provider no multi-LLM router (ja suportado)
- Delegar tarefas complexas especificamente para Claude
- Usar extended thinking do Claude para planejamento

**Status:** Informacional — nao implementado. Para versao final.

## 8.2 Decisoes Arquiteturais para Versao Final

### Framework vs Vanilla JS
**Prototipo:** Tudo em vanilla JS (script.js com 7400 linhas).
**Para producao:** Considerar React/Vue/Svelte para:
- Componentizacao (cada modal/painel como componente)
- State management centralizado
- Roteamento SPA
- Build otimizado

### Backend
**Prototipo:** server.js com HTTP puro, ~1035 linhas.
**Para producao:** Considerar:
- Next.js / Nuxt para SSR
- API routes separadas por funcionalidade
- Rate limiting e autenticacao por token
- WebSocket server para tempo real

### Database
**Prototipo:** localStorage (primario) + Supabase (sync).
**Para producao:** Supabase como fonte de verdade com:
- Schema definido (migrations)
- Row-level security
- Realtime subscriptions
- Edge functions para logica server-side

## 8.3 Features Discutidas Mas Nao Implementadas

### Integracao com CRM
- Conectar SENNA ao CRM do Grupo Romper
- Lead scoring automatico via IA
- Notificacoes de follow-up

### Automacoes n8n Avancadas
- Endpoint `/api/automate` existe mas workflows sao basicos
- Visao: SENNA orquestra workflows complexos (email + CRM + calendario)

### Google Drive Deep Integration
- Fase 3 implementou exportacao basica
- Falta: sync bidirecional, busca em documentos do Drive

### Analytics Dashboard
- Dashboard com metricas de uso do SENNA
- Quantas perguntas por dia, custo acumulado, skills mais usadas
- ROI do assistente (tempo economizado)

### Multi-usuario
- Atualmente single-user com restricao de dominio
- Falta: roles (admin, user), configuracoes por usuario
- Falta: conversas compartilhadas entre time

### Mobile Optimization
- PWA instalavel existe
- Falta: UI responsiva testada, gestos touch, notificacoes push

## 8.4 Padroes de Codigo Estabelecidos no Prototipo

### Modais
```javascript
function openXxxModal() {
  const modal = document.createElement('div');
  modal.className = 'xxx-modal';
  modal.innerHTML = `...`;
  document.body.appendChild(modal);
  modal.querySelector('.close').onclick = () => modal.remove();
}
```

### Objetos Manager/Engine
```javascript
const XxxManager = {
  data: [],
  getData() { return JSON.parse(localStorage.getItem('senna_xxx') || '[]'); },
  saveData(d) { localStorage.setItem('senna_xxx', JSON.stringify(d)); },
  async execute() { /* logica */ },
};
```

### LLM Call (non-streaming)
```javascript
async function callSherlockLLM(prompt) {
  const resp = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      forceProvider: 'openai'
    })
  });
  const data = await resp.json();
  return data.choices[0].message.content;
}
```

### Self-Actions
```javascript
const ACTION_HANDLERS = {
  nome_acao: () => { /* executa */ },
};
// No prompt: "[ACTION:nome_acao]"
// No parse: detecta tag → executa handler
```

## 8.5 Licoes Aprendidas

1. **localStorage como cache, nao como source of truth.** Funciona pra prototipo mas perde dados facilmente.
2. **Proxy de API no server.js e essencial.** Mixed content (HTTPS→HTTP) bloqueia tudo.
3. **AudioContext do browser e fragil.** Suspende em troca de aba, limite de instancias, precisa de gesto do usuario pra iniciar.
4. **Web Speech API como fallback obrigatorio.** Kokoro pode cair, AssemblyAI pode expirar — sempre ter fallback.
5. **body.className nunca deve ser sobrescrito inteiro.** Usar classList.add/remove, nunca `.className =`.
6. **Null-check tudo no DOM.** Elementos podem nao existir dependendo do modo/estado.
7. **7400 linhas num arquivo so e insustentavel.** Precisa modularizar na versao final.
8. **5 dias de prototipo validam a ideia.** Agora precisa de arquitetura pensada para escalar.

## 8.6 Arquitetura de Referencia para Versao Final

```
senna-app/
├── frontend/           # React/Svelte
│   ├── components/     # UI componentes
│   │   ├── Chat/
│   │   ├── Voice/
│   │   ├── Skills/
│   │   ├── Radar/
│   │   ├── Cockpit/
│   │   └── Settings/
│   ├── stores/         # State management
│   ├── hooks/          # Custom hooks
│   └── lib/            # Utilitarios
├── backend/            # API routes
│   ├── chat.ts         # LLM routing
│   ├── tts.ts          # TTS proxy
│   ├── stt.ts          # STT token
│   ├── health.ts       # Health check
│   └── deploy.ts       # Webhook
├── services/           # Logica de negocio
│   ├── MemoryEngine/
│   ├── SkillsEngine/
│   ├── RadarManager/
│   ├── DiscoveryEngine/
│   └── VoiceEngine/
├── supabase/
│   ├── migrations/
│   └── functions/
└── docker/
    ├── kokoro/
    ├── ollama/
    └── n8n/
```

---

**Este documento deve ser atualizado conforme novas ideias surgirem.**
