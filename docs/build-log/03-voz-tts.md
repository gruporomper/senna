# Parte 3 — Voz e TTS (03-06/04/2026)

## 3.1 TTS — Evolucao dos Motores de Voz
**Cronologia:**
1. **ElevenLabs** — motor inicial, API paga por caracter
2. **Piper TTS** (`5713b9c`) — primeira tentativa self-hosted, qualidade limitada em PT-BR
3. **Kokoro TTS** (`48ed379`) — motor final, self-hosted em localhost:8880, voz `pm_alex`, qualidade muito superior

**Arquitetura TTS:**
```
Browser → fetch('/api/tts') → server.js (proxy) → Kokoro (localhost:8880/v1/audio/speech) → audio/wav
```
- Server.js faz proxy para evitar mixed content (HTTPS → HTTP)
- Formato: WAV (sem compressao, menor latencia)
- Fallback: Web Speech API do navegador quando Kokoro indisponivel

## 3.2 Funcao `speak()` em script.js
**O que faz:** Recebe texto → chama /api/tts → reproduz audio → anima capacete
**Fluxo:**
1. Para audio anterior se existir
2. Cancela synthesis do Web Speech
3. POST /api/tts com modelo kokoro, voz pm_alex, formato wav
4. Se Kokoro falhar → `speakFallback()` (Web Speech API)
5. Cria blob URL → Audio() → play()
6. Conecta AudioContext + Analyser para pulsacao do capacete
7. onended: limpa blob URL, para animacao

**Problemas corrigidos (06/04 — `8fed8bd`):**
- `audio.play().catch(() => {})` engolia erros silenciosamente → agora faz fallback
- Criava novo AudioContext a cada chamada → agora reutiliza
- Blob URL vazava em cenarios de erro → cleanup garantido em todos os paths
- AudioContext suspenso apos troca de aba → resume automatico

## 3.3 Funcao `speakFallback()` em script.js
**O que faz:** Fallback usando Web Speech API do navegador (SpeechSynthesisUtterance)
**Config:** lang pt-BR, rate 1.05, pitch 0.95
**Priorizacao de vozes:** Google PT-BR > qualquer PT-BR > qualquer PT
**Problema corrigido:** `getVoices()` pode retornar vazio na primeira chamada — agora aguarda evento `voiceschanged` com timeout de 500ms

## 3.4 Voice Engine (`voice-engine.js`)
**Commit principal:** `e7e0dd1`
**O que e:** Maquina de estados para conversa continua por voz.
**Estados:** IDLE → LISTENING → THINKING → SPEAKING (+ ERROR)

**Componentes:**
- **VAD (Voice Activity Detection):** Detecta quando usuario comeca/para de falar
- **STT (Speech-to-Text):** AssemblyAI via WebSocket (primario) ou Web Speech API (fallback)
- **TTS:** Kokoro via fetch, com fila de chunks para streaming
- **Barge-in:** Interrupcao — usuario fala durante TTS, para tudo e volta a ouvir
- **AudioWorklet:** Processa audio do mic em tempo real para enviar ao AssemblyAI

**Configuracao (CONFIG):**
```
VAD: speechThreshold 0.8, negativeSpeech 0.15, redemptionFrames 8
STT: sampleRate 16000, language 'pt', endUtteranceSilence 1000ms
TTS: voice pm_alex, model kokoro, maxInFlight 2, format wav
Timeouts: sttIdle 30s, turnCommit 1.5s, errorRecovery 3s
```

## 3.5 Voice Engine — Lifecycle

### init()
- Verifica getUserMedia disponivel
- Testa token AssemblyAI — se nao configurado, usa Web Speech API
- Verifica Web Speech API como fallback
- **Fix (06/04):** Adiciona listener `visibilitychange` para retomar AudioContext ao voltar para aba
- **Fix (06/04):** Se indisponivel, desabilita orb e mic com opacity 0.3

### activate()
- Pede permissao de mic
- Web Speech mode: inicia recognition direto
- AssemblyAI mode: getUserMedia → AudioContext → AudioPipeline → VAD → STT token → WebSocket
- Cria TTS AudioContext se nao existe
- Transiciona para LISTENING
- **Fix (06/04):** Verifica permissao de mic antes de tudo (permissions.query)
- **Fix (06/04):** Mensagens de erro especificas (NotAllowedError, NotFoundError)
- **Fix (06/04):** Resume ttsAudioContext se suspenso

### deactivate()
- Remove classe voice-active
- Flush TTS queue
- Cleanup (fecha streams, sockets, contexts)

## 3.6 Voice Engine — TTS Pipeline

### Sentence Accumulator
- LLM responde em streaming → texto acumula em `sentenceBuffer`
- Quando detecta delimitador (`.!?`) + minimo 10 chars → cria chunk TTS
- Force flush em 300 chars se nao houver delimitador

### fetchTTSChunk()
- Faz POST para /api/tts com texto do chunk
- Decodifica audio com ttsAudioContext.decodeAudioData()
- Marca como 'ready' e tenta reproduzir
- **Fix (06/04):** Se Kokoro falhar, usa Web Speech API como fallback para o chunk

### playNextChunk()
- Pula chunks falhos (audioBuffer null)
- Conecta source → gainNode → analyser → destination
- Controle de volume via gainNode
- Ao terminar chunk, reproduz proximo ou volta a LISTENING

## 3.7 Voice Engine — Barge-in (`bargeIn()`)
**O que:** Usuario interrompe SENNA enquanto fala.
**Fluxo:**
1. Flush TTS queue (para audio)
2. Abort LLM fetch
3. Reset sentence buffer + transcript
4. Limpa cockpit transcript
5. Volta para LISTENING
6. Reinicia Web Speech Recognition
**Fix (06/04):** Se recognition.start() falhar, re-inicializa do zero em vez de silenciar

## 3.8 Voice Engine — Pause/Resume
**pauseConversation():**
- Suspende ttsAudioContext
- Para Web Speech Recognition
- Aborta LLM se pensando
- Atualiza UI do botao pause

**resumeConversation():**
- Resume ttsAudioContext
- **Fix (06/04):** Resume tambem audioContext do mic
- **Fix (06/04):** Renova STT token se expirou durante pausa
- Reinicia recognition se estava ouvindo
- **Fix (06/04):** Se recognition.start() falhar, re-inicializa

## 3.9 Voice Cockpit (`88b589f`)
**O que:** Overlay fullscreen para modo conversa por voz.
**Componentes:** Capacete grande, visualizacao de onda, controles de media.
**Decisao:** Removido overlay — modo inline onde mic e unico controle no Box (`ac1230e`)

## 3.10 Media Toolbar (`fb5eed5`)
**O que:** Barra de controles de media: play/pause, velocidade, volume, mic.
**Estilo:** Verde esmeralda, tema F1.
**Controles:**
- Play/pause com toggle de icone
- Slider de velocidade em popup
- Slider de volume ancorado ao botao
- Botao stop para encerrar sessao de voz

## 3.11 Walkie-Talkie Mode (`7627e13`)
**O que:** Modo push-to-talk com deteccao de silencio.
**Como funciona:**
- VAD detecta fim de fala
- Auto-envia mensagem
- Auto-reproduz resposta em TTS
- Barge-in para interromper

## 3.12 Pulsacao do Capacete
- **Durante gravacao** (`961ef60`): Analyser do mic → amplitude → escala do capacete
- **Durante fala** (`ff98ea7`): Analyser do TTS → amplitude → escala do capacete
- Funcao: `animateSpeakingHelmet()` / `animateRecordingHelmet()`

## 3.13 Problemas TTS Historicos
- TTS nao tocava no Box — stream bloqueava esperando captures (`c8f0ad1`)
- Mixed content block — browser nao permite HTTP fetch de pagina HTTPS → proxy no server.js (`3e78b9e`)
- setState() limpava classes voice-active e mode-home do body (`8379d5e`)
- Bolhas de chat duplicavam durante modo voz (`bacfb13`)

---

**Total de commits de voz:** ~30 commits
**Periodo:** 03/04 a 06/04/2026
