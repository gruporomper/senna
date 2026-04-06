# Parte 7 — Bugs e Fixes

## Bugs Criticos

### orbStatus null crash (`0818ed7`)
**Sintoma:** TODA funcionalidade do app quebrava.
**Causa:** `orbStatus` era null, qualquer acesso a `.textContent` crashava.
**Fix:** Null-check antes de acessar orbStatus.
**Licao:** Sempre fazer null-check em elementos DOM que podem nao existir.

### Supabase global conflict (`d4c6c82`, `0077a37`)
**Sintoma:** Login nao funcionava, erros de `supabase is not defined`.
**Causa:** Variavel `let supabase` conflitava com o global `window.supabase` do CDN.
**Fix 1:** Renomear para `supabaseClient`
**Fix 2:** Fixar CDN em v2.45.0 (versao mais nova mudou API)
**Licao:** Cuidado com nomes de variaveis que colidem com globals de bibliotecas.

### TTS nao tocava no Box (`c8f0ad1`)
**Sintoma:** Audio de voz nunca reproduzia no modo Box (home).
**Causa:** Stream do LLM bloqueava esperando captures do CockpitManager.
**Fix:** Remover dependencia de captures para TTS funcionar.
**Licao:** Pipeline de audio nao pode depender de UI/state nao relacionado.

## Bugs de Layout/UI

### Recording bar overflow (`6b47567`)
**Sintoma:** Botoes saiam da barra de gravacao.
**Fix:** Botoes menores + overflow hidden.

### Chat scroll bloqueado (`8eb053d`)
**Sintoma:** Nao conseguia scrollar para cima no chat.
**Causa:** `justify-content: flex-end` no container empurrava tudo pra baixo.
**Fix:** Remover justify-content.

### setState() limpava classes (`8379d5e`)
**Sintoma:** Modo voz e modo home quebravam ao mudar estado.
**Causa:** `setState()` fazia `body.className = '...'` apagando voice-active e mode-home.
**Fix:** Preservar classes existentes ao setar estado.

### Input bar com max-width (`608094f`)
**Sintoma:** Input bar nao ocupava largura total.
**Fix:** Remover max-width constraint.

### Quick Actions escondidos (`80b2419`)
**Sintoma:** Chips de acao rapida nunca apareciam.
**Causa:** `renderQuickActions()` tinha `return` prematuro + `display:none` no HTML.
**Fix:** Remover ambos bloqueios.

### Cockpit vazando entre modos (`1946fd0`)
**Sintoma:** Dashboard/cockpit aparecia no modo sessao.
**Fix:** `setAppMode()` esconde/mostra elementos corretos.

### Sessoes duplicadas (`3e84622`)
**Sintoma:** Cada "Novo Chat" criava sessao duplicada.
**Fix:** Reutilizar sessao vazia existente.

## Bugs de Voz/TTS (06/04 — `8fed8bd`)

### audio.play() silencioso
**Sintoma:** Erro de reproducao ignorado, usuario nao ouve nada sem saber por que.
**Causa:** `.catch(() => {})` engolia qualquer erro.
**Fix:** Log do erro + fallback para Web Speech API.

### AudioContext novo a cada chamada
**Sintoma:** Performance degradava com o tempo, possiveis memory leaks.
**Causa:** `new AudioContext()` em cada `speak()`.
**Fix:** Reutilizar instancia existente, so criar se fechada.

### AudioContext suspenso apos troca de aba
**Sintoma:** Audio parava de funcionar depois de trocar de aba e voltar.
**Causa:** Navegadores suspendem AudioContext de abas inativas.
**Fix:** `visibilitychange` listener + resume automatico.

### getVoices() vazio
**Sintoma:** Fallback Web Speech nao usava voz PT-BR.
**Causa:** `getVoices()` retorna vazio na primeira chamada em alguns navegadores.
**Fix:** Aguardar evento `voiceschanged` com timeout 500ms.

### VoiceEngine.init() falha invisivel
**Sintoma:** Orb parecia funcional mas voz nao ativava.
**Causa:** `.catch()` so logava warning no console.
**Fix:** Desabilitar orb/mic visualmente (opacity 0.3 + tooltip).

### fetchTTSChunk sem fallback
**Sintoma:** Chunks de audio falhavam silenciosamente, fala ficava cortada.
**Fix:** Fallback para Web Speech API por chunk individual.

### Barge-in quebrava recognition
**Sintoma:** Apos interromper SENNA, mic nao voltava a funcionar.
**Causa:** `recognition.start()` falhava se recognition ainda ativo.
**Fix:** Try/catch + re-inicializar recognition do zero se falhar.

### Mic permission nao verificada
**Sintoma:** Erro generico ao ativar sem permissao de mic.
**Fix:** `permissions.query({ name: 'microphone' })` antes de ativar.

### Blob URL leak
**Sintoma:** Memoria crescia com blob URLs nao revogados.
**Causa:** Se `audio.play()` falhava, onended/onerror nunca disparavam.
**Fix:** Cleanup function centralizada chamada em todos os paths de erro.

### Resume incompleto
**Sintoma:** Apos pausar e retomar, audio ou mic nao voltavam.
**Causa:** So resumia ttsAudioContext, nao o audioContext do mic.
**Fix:** Resume ambos + renovar STT token se expirou.

## Bugs de Seguranca

### Secrets no deploy script (`53c2013`)
**Sintoma:** API keys expostas no repositorio.
**Fix:** Removidas, template criado para preenchimento manual.

### Deploy sem autenticacao (`8297990`)
**Sintoma:** Qualquer POST em /api/deploy trigava deploy.
**Fix:** Verificacao HMAC da assinatura do GitHub.

---

**Total de bug fixes:** ~25 commits dedicados
