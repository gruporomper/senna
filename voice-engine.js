// ===== SENNA VOICE ENGINE =====
// Continuous, interruptible voice conversation system
// States: IDLE → LISTENING → THINKING → SPEAKING (+ ERROR)

(function () {
  'use strict';

  // ===== CONFIGURATION =====
  const CONFIG = {
    // VAD
    vadPositiveSpeechThreshold: 0.8,
    vadNegativeSpeechThreshold: 0.15,
    vadMinSpeechFrames: 5,
    vadPreSpeechPadFrames: 3,
    vadRedemptionFrames: 8,

    // STT
    sttTokenEndpoint: '/api/stt/token',
    sttSampleRate: 16000,
    sttLanguage: 'pt',
    sttEndUtteranceSilence: 1000, // ms, AssemblyAI server-side endpointing

    // TTS
    ttsEndpoint: '/api/tts',
    ttsVoice: 'pm_alex',
    ttsModel: 'kokoro',
    ttsMaxInFlight: 2, // max parallel TTS fetches
    ttsFormat: 'wav',

    // Sentence accumulator
    sentenceDelimiters: /([.!?])\s/,
    sentenceMinLength: 10, // don't chunk tiny fragments
    sentenceForceFlushLength: 300, // flush if sentence gets too long

    // Timeouts
    sttIdleTimeoutMs: 30000, // close STT socket after 30s silence
    sttTurnCommitMs: 1500, // commit turn after 1.5s silence following a final transcript
    errorRecoveryMs: 3000, // auto-recover from ERROR after 3s
    bargeInCooldownMs: 100, // min time between barge-in events

    // Audio
    audioWorkletPath: '/audio-processor.worklet.js',
    micConstraints: {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: { ideal: 16000 }
      }
    }
  };

  // ===== VALID STATE TRANSITIONS =====
  const TRANSITIONS = {
    IDLE:      ['LISTENING', 'ERROR'],
    LISTENING: ['THINKING', 'IDLE', 'ERROR'],
    THINKING:  ['SPEAKING', 'LISTENING', 'IDLE', 'ERROR'],
    SPEAKING:  ['LISTENING', 'IDLE', 'ERROR'],
    ERROR:     ['IDLE']
  };

  // State labels for existing setState() CSS integration
  const STATE_MAP = {
    IDLE: 'idle',
    LISTENING: 'listening',
    THINKING: 'thinking',
    SPEAKING: 'speaking',
    ERROR: 'idle' // ERROR uses idle CSS (no special style yet)
  };

  // ===== VOICE ENGINE SINGLETON =====
  const VoiceEngine = {
    // --- State ---
    state: 'IDLE',
    available: false,
    legacyMode: false,
    useFallbackSTT: false,

    // --- Audio pipeline ---
    audioContext: null,
    micStream: null,
    workletNode: null,

    // --- VAD ---
    vadInstance: null,

    // --- STT ---
    sttSocket: null,
    sttToken: null,
    sttTokenExpiresAt: null,
    sttTranscript: '',         // accumulated final transcript
    sttPartial: '',            // current partial
    sttIdleTimer: null,

    // --- LLM ---
    llmAbort: null,            // AbortController for current LLM fetch

    // --- TTS queue ---
    ttsQueue: [],              // [{ text, abortController, audioBuffer, status: 'pending'|'fetching'|'ready'|'playing' }]
    ttsAbortControllers: [],
    currentAudioSource: null,
    nextPlayTime: 0,
    ttsAudioContext: null,     // dedicated AudioContext for TTS playback
    ttsSpeakAnalyser: null,    // for helmet pulse animation

    // --- Turn commit ---
    turnCommitTimer: null,

    // --- Sentence accumulator ---
    sentenceBuffer: '',

    // --- Metrics ---
    metrics: {
      sessionStart: null,
      vadStartToSttOpen: null,
      speechEndToLlmStart: null,
      llmStartToFirstText: null,
      firstTextToFirstAudio: null,
      endOfTurnToFirstPhoneme: null,
      bargeInCount: 0,
      fallbackVadFailCount: 0,
      totalSessions: 0
    },
    _timestamps: {},

    // ===== LIFECYCLE =====

    isAvailable() {
      return this.available && !this.legacyMode;
    },

    async init() {
      console.log('[VoiceEngine] Initializing...');

      // Check for basic requirements
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        console.warn('[VoiceEngine] getUserMedia not available, falling back to legacy');
        this.legacyMode = true;
        return;
      }

      // Check if AssemblyAI is configured
      try {
        const tokenResp = await fetch(CONFIG.sttTokenEndpoint, { method: 'POST' });
        const tokenData = await tokenResp.json();
        if (tokenData.error || tokenData.fallback) {
          console.warn('[VoiceEngine] AssemblyAI not configured:', tokenData.error);
          this.legacyMode = true;
          return;
        }
        // Don't store token yet — will fetch fresh one on activate()
      } catch (err) {
        console.warn('[VoiceEngine] STT token check failed:', err.message);
        this.legacyMode = true;
        return;
      }

      this.available = true;
      console.log('[VoiceEngine] Available. AssemblyAI configured.');
    },

    async activate() {
      if (!this.available) return;
      if (this.state !== 'IDLE') return;

      console.log('[VoiceEngine] Activating voice session...');
      this.metrics.sessionStart = performance.now();
      this.metrics.totalSessions++;

      try {
        // 1. Get mic stream
        this.micStream = await navigator.mediaDevices.getUserMedia(CONFIG.micConstraints);

        // 2. Create AudioContext
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
          sampleRate: CONFIG.sttSampleRate
        });

        // 3. Setup audio pipeline (AudioWorklet + STT feed)
        await this.setupAudioPipeline();

        // 4. Init VAD (if available)
        await this.initVAD();

        // 5. Get STT token and open WebSocket
        await this.fetchSTTToken();
        await this.openSTTSocket();

        // 6. Transition to LISTENING
        this.transition('LISTENING');

        // Show recording UI
        this._showRecordingUI();

      } catch (err) {
        console.error('[VoiceEngine] Activation failed:', err);
        this.cleanup();
        this.transition('ERROR');
      }
    },

    deactivate() {
      console.log('[VoiceEngine] Deactivating...');
      this.flushTTSQueue();
      this.cleanup();
      this.sentenceBuffer = '';
      this.sttTranscript = '';
      this.sttPartial = '';
      if (typeof removeLiveTranscript === 'function') removeLiveTranscript();
      this._hideRecordingUI();
      this.transition('IDLE');
    },

    cleanup() {
      // Abort any in-flight LLM request
      if (this.llmAbort) { this.llmAbort.abort(); this.llmAbort = null; }

      // Close STT socket
      this.closeSTTSocket();

      // Destroy VAD
      if (this.vadInstance) {
        try { this.vadInstance.destroy(); } catch (e) {}
        this.vadInstance = null;
      }

      // Close AudioWorklet
      if (this.workletNode) {
        this.workletNode.disconnect();
        this.workletNode = null;
      }

      // Close AudioContext
      if (this.audioContext && this.audioContext.state !== 'closed') {
        this.audioContext.close().catch(() => {});
        this.audioContext = null;
      }

      // Stop mic stream
      if (this.micStream) {
        this.micStream.getTracks().forEach(t => t.stop());
        this.micStream = null;
      }

      // Clear idle timer
      if (this.sttIdleTimer) { clearTimeout(this.sttIdleTimer); this.sttIdleTimer = null; }
    },

    // ===== STATE MACHINE =====

    transition(newState) {
      const allowed = TRANSITIONS[this.state];
      if (!allowed || !allowed.includes(newState)) {
        console.warn(`[VoiceEngine] Invalid transition: ${this.state} → ${newState}`);
        return false;
      }

      const oldState = this.state;
      this.state = newState;
      console.log(`[VoiceEngine] ${oldState} → ${newState}`);

      // Sync with existing CSS state system
      if (typeof setState === 'function') {
        setState(STATE_MAP[newState] || 'idle');
      }

      // Dispatch event for UI hooks
      document.dispatchEvent(new CustomEvent('voiceStateChange', {
        detail: { from: oldState, to: newState }
      }));

      // Auto-recovery from ERROR
      if (newState === 'ERROR') {
        setTimeout(() => {
          if (this.state === 'ERROR') {
            this.cleanup();
            this.state = 'IDLE'; // direct set, not transition
            if (typeof setState === 'function') setState('idle');
          }
        }, CONFIG.errorRecoveryMs);
      }

      return true;
    },

    // ===== ORB/UI HANDLER =====

    handleOrbClick() {
      switch (this.state) {
        case 'IDLE':
          this.activate();
          break;
        case 'LISTENING':
          if (this.sttTranscript.trim()) {
            // Force-send current transcript
            this.commitTurn(this.sttTranscript.trim());
          } else {
            // No transcript — cancel
            this.deactivate();
          }
          break;
        case 'THINKING':
        case 'SPEAKING':
          this.bargeIn();
          break;
        case 'ERROR':
          this.cleanup();
          this.state = 'IDLE';
          if (typeof setState === 'function') setState('idle');
          break;
      }
    },

    // ===== AUDIO PIPELINE =====

    async setupAudioPipeline() {
      if (!this.audioContext || !this.micStream) return;

      try {
        // Load AudioWorklet module
        await this.audioContext.audioWorklet.addModule(CONFIG.audioWorkletPath);

        const source = this.audioContext.createMediaStreamSource(this.micStream);
        this.workletNode = new AudioWorkletNode(this.audioContext, 'audio-processor');

        // Receive PCM buffers from worklet
        this.workletNode.port.onmessage = (e) => {
          const pcmData = e.data.pcm16; // Int16Array from worklet
          if (pcmData) this.sendAudioToSTT(pcmData);
        };

        source.connect(this.workletNode);
        // Don't connect worklet to destination — we don't want to hear our own mic
      } catch (err) {
        console.warn('[VoiceEngine] AudioWorklet failed, trying ScriptProcessor fallback:', err);
        this._setupScriptProcessorFallback();
      }
    },

    _setupScriptProcessorFallback() {
      // Deprecated but works everywhere including old Safari
      if (!this.audioContext || !this.micStream) return;

      const source = this.audioContext.createMediaStreamSource(this.micStream);
      const processor = this.audioContext.createScriptProcessor(4096, 1, 1);
      const targetRate = CONFIG.sttSampleRate;
      const sourceRate = this.audioContext.sampleRate;

      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        // Resample if needed
        let samples;
        if (sourceRate !== targetRate) {
          const ratio = sourceRate / targetRate;
          const newLength = Math.floor(input.length / ratio);
          samples = new Int16Array(newLength);
          for (let i = 0; i < newLength; i++) {
            const srcIdx = Math.floor(i * ratio);
            samples[i] = Math.max(-32768, Math.min(32767, Math.floor(input[srcIdx] * 32767)));
          }
        } else {
          samples = new Int16Array(input.length);
          for (let i = 0; i < input.length; i++) {
            samples[i] = Math.max(-32768, Math.min(32767, Math.floor(input[i] * 32767)));
          }
        }
        this.sendAudioToSTT(samples);
      };

      source.connect(processor);
      processor.connect(this.audioContext.destination); // required for ScriptProcessor to work
      this.workletNode = processor; // store for cleanup
    },

    // ===== STT (AssemblyAI WebSocket) =====

    async fetchSTTToken() {
      this._mark('stt_token_start');
      const resp = await fetch(CONFIG.sttTokenEndpoint, { method: 'POST' });
      const data = await resp.json();
      if (data.error) throw new Error(`STT token error: ${data.error}`);
      this.sttToken = data.token;
      this.sttTokenExpiresAt = data.expires_at || (Date.now() + 3600000);
      this._mark('stt_token_end');
    },

    async openSTTSocket() {
      if (!this.sttToken) throw new Error('No STT token');

      return new Promise((resolve, reject) => {
        const url = `wss://api.assemblyai.com/v2/realtime/ws?sample_rate=${CONFIG.sttSampleRate}&token=${this.sttToken}&language_code=${CONFIG.sttLanguage}&end_utterance_silence_threshold=${CONFIG.sttEndUtteranceSilence}`;

        this.sttSocket = new WebSocket(url);

        this.sttSocket.onopen = () => {
          console.log('[VoiceEngine] STT WebSocket connected');
          this._measure('vad_start_to_stt_open');
          resolve();
        };

        this.sttSocket.onmessage = (event) => {
          this.onSTTMessage(event);
        };

        this.sttSocket.onerror = (err) => {
          console.error('[VoiceEngine] STT WebSocket error:', err);
          reject(err);
        };

        this.sttSocket.onclose = (event) => {
          console.log('[VoiceEngine] STT WebSocket closed:', event.code, event.reason);
          // If unexpected close during active session, try to reconnect
          if (this.state === 'LISTENING' || this.state === 'THINKING') {
            this._reconnectSTT();
          }
        };
      });
    },

    closeSTTSocket() {
      if (this.sttSocket) {
        try {
          if (this.sttSocket.readyState === WebSocket.OPEN) {
            this.sttSocket.send(JSON.stringify({ terminate_session: true }));
          }
          this.sttSocket.close();
        } catch (e) {}
        this.sttSocket = null;
      }
    },

    async _reconnectSTT() {
      console.log('[VoiceEngine] Attempting STT reconnect...');
      try {
        // Refresh token if expired
        if (!this.sttToken || Date.now() > this.sttTokenExpiresAt - 60000) {
          await this.fetchSTTToken();
        }
        await this.openSTTSocket();
      } catch (err) {
        console.error('[VoiceEngine] STT reconnect failed:', err);
        this.transition('ERROR');
      }
    },

    onSTTMessage(event) {
      try {
        const msg = JSON.parse(event.data);

        // Reset idle timer on any message
        this._resetIdleTimer();

        if (msg.message_type === 'PartialTranscript') {
          this.sttPartial = msg.text || '';
          // Show live transcript
          const displayText = (this.sttTranscript + ' ' + this.sttPartial).trim();
          if (displayText && typeof updateLiveTranscript === 'function') {
            updateLiveTranscript(displayText);
          }

          // If receiving partials during SPEAKING → potential barge-in
          if (this.state === 'SPEAKING' && this.sttPartial.length > 3) {
            // Fallback barge-in for Safari (no VAD)
            if (this.useFallbackSTT) {
              this.bargeIn();
            }
          }
        }

        if (msg.message_type === 'FinalTranscript') {
          const text = msg.text || '';
          if (text.trim()) {
            this.sttTranscript += (this.sttTranscript ? ' ' : '') + text.trim();
            this.sttPartial = '';
            // Update live transcript with final
            if (typeof updateLiveTranscript === 'function') {
              updateLiveTranscript(this.sttTranscript);
            }
          }
        }

        // Turn end = AssemblyAI detected end of utterance
        if (msg.message_type === 'SessionTerminated') {
          // Session ended by server
          return;
        }

        // Start turn-commit timer after each FinalTranscript
        // If no more speech arrives within sttTurnCommitMs, commit the turn
        if (msg.message_type === 'FinalTranscript' && this.sttTranscript.trim() && this.state === 'LISTENING') {
          this._resetTurnCommitTimer();
        }

      } catch (err) {
        console.error('[VoiceEngine] STT message parse error:', err);
      }
    },

    _resetIdleTimer() {
      if (this.sttIdleTimer) clearTimeout(this.sttIdleTimer);

      // After silence, commit the turn if we have transcript
      this.sttIdleTimer = setTimeout(() => {
        if (this.state === 'LISTENING' && this.sttTranscript.trim()) {
          this.commitTurn(this.sttTranscript.trim());
        } else if (this.state === 'LISTENING' && !this.sttTranscript.trim()) {
          // Long silence with no speech — close session to save cost
          console.log('[VoiceEngine] Idle timeout, deactivating');
          this.deactivate();
        }
      }, CONFIG.sttIdleTimeoutMs);
    },

    _resetTurnCommitTimer() {
      if (this.turnCommitTimer) clearTimeout(this.turnCommitTimer);
      this.turnCommitTimer = setTimeout(() => {
        if (this.state === 'LISTENING' && this.sttTranscript.trim()) {
          this.commitTurn(this.sttTranscript.trim());
        }
      }, CONFIG.sttTurnCommitMs);
    },

    _clearTurnCommitTimer() {
      if (this.turnCommitTimer) { clearTimeout(this.turnCommitTimer); this.turnCommitTimer = null; }
    },

    sendAudioToSTT(pcmData) {
      if (!this.sttSocket || this.sttSocket.readyState !== WebSocket.OPEN) return;

      // Convert Int16Array to base64
      const bytes = new Uint8Array(pcmData.buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = btoa(binary);

      this.sttSocket.send(JSON.stringify({ audio_data: base64 }));
    },

    // ===== TURN COMMIT =====

    commitTurn(text) {
      if (!text || this.state !== 'LISTENING') return;

      console.log('[VoiceEngine] Committing turn:', text.substring(0, 50) + '...');

      // Clear timers and transcript
      this._clearTurnCommitTimer();
      this.sttTranscript = '';
      this.sttPartial = '';
      if (typeof removeLiveTranscript === 'function') removeLiveTranscript();

      this._mark('turn_committed');
      this.transition('THINKING');

      // Process the voice command with sentence-by-sentence TTS
      this.processVoiceCommand(text);
    },

    // ===== VOICE COMMAND PROCESSING =====

    async processVoiceCommand(text) {
      try {
        // Add user message to chat
        if (typeof addMessage === 'function' && typeof appMode !== 'undefined') {
          if (appMode !== 'home') {
            addMessage(text, 'user');
          } else {
            if (typeof addPerpetualMessage === 'function') addPerpetualMessage(text, 'user');
          }
        }

        // Create empty assistant message placeholder
        const isSession = (typeof appMode !== 'undefined' && appMode !== 'home');
        if (isSession) {
          if (typeof addMessage === 'function') addMessage('', 'assistant', false);
        } else {
          if (typeof addPerpetualMessage === 'function') addPerpetualMessage('', 'assistant');
        }
        const msgContainer = isSession
          ? (typeof messagesWrap !== 'undefined' ? messagesWrap.lastElementChild : null)
          : (typeof perpetualMessages !== 'undefined' ? perpetualMessages.lastElementChild : null);

        // Setup AbortController for LLM
        this.llmAbort = new AbortController();
        this.sentenceBuffer = '';

        this._mark('llm_start');

        // Determine provider from prefix
        const prefix = (typeof parseModelPrefix === 'function') ? parseModelPrefix(text) : { text, provider: null, model: null };

        // Stream LLM response with sentence accumulation
        const response = await callGrokAPIStream(
          prefix.text, msgContainer,
          prefix.provider, prefix.model, false,
          {
            signal: this.llmAbort.signal,
            onToken: (token, fullContent) => {
              // First token timing
              if (!this._timestamps.llm_first_token) {
                this._timestamps.llm_first_token = performance.now();
                this._measure('llm_start_to_first_text');
              }
              // Accumulate sentences
              this.accumulateSentence(token);
            }
          }
        );

        // Flush remaining sentence buffer
        if (this.sentenceBuffer.trim()) {
          this.enqueueTTS(this.sentenceBuffer.trim());
          this.sentenceBuffer = '';
        }

        // Append model badge
        if (msgContainer && typeof appendModelBadge === 'function') {
          appendModelBadge(msgContainer);
        }

        // Save conversation if in session mode
        if (isSession && typeof activeConversationId !== 'undefined' && activeConversationId) {
          if (typeof ConversationManager !== 'undefined') {
            ConversationManager.save(activeConversationId, conversationHistory);
            if (typeof renderConversationList === 'function') renderConversationList();
          }
        }

        // If no TTS chunks were enqueued (very short response), transition directly
        if (this.ttsQueue.length === 0 && this.state === 'THINKING') {
          this.transition(window.walkieTalkieMode ? 'LISTENING' : 'IDLE');
          if (!window.walkieTalkieMode) this._hideRecordingUI();
        }

      } catch (err) {
        if (err.name === 'AbortError') {
          console.log('[VoiceEngine] LLM request aborted (barge-in)');
          return; // barge-in handled, don't error
        }
        if (err.message === '__BUDGET_DECLINED__') {
          if (typeof showToast === 'function') showToast('Consulta cancelada pelo limite de custo.', 'warning');
          this.transition('IDLE');
          this._hideRecordingUI();
          return;
        }
        console.error('[VoiceEngine] processVoiceCommand error:', err);
        this.transition('ERROR');
      }
    },

    // ===== SENTENCE ACCUMULATOR =====

    accumulateSentence(token) {
      this.sentenceBuffer += token;

      // Force flush if buffer gets too long
      if (this.sentenceBuffer.length >= CONFIG.sentenceForceFlushLength) {
        // Find last good break point
        const lastBreak = Math.max(
          this.sentenceBuffer.lastIndexOf('. '),
          this.sentenceBuffer.lastIndexOf('! '),
          this.sentenceBuffer.lastIndexOf('? '),
          this.sentenceBuffer.lastIndexOf('\n')
        );
        if (lastBreak > CONFIG.sentenceMinLength) {
          const sentence = this.sentenceBuffer.substring(0, lastBreak + 1).trim();
          this.sentenceBuffer = this.sentenceBuffer.substring(lastBreak + 1);
          if (sentence) this.enqueueTTS(sentence);
        } else {
          // No good break — flush everything
          this.enqueueTTS(this.sentenceBuffer.trim());
          this.sentenceBuffer = '';
        }
        return;
      }

      // Check for natural sentence boundary
      const match = this.sentenceBuffer.match(/^(.*?[.!?])\s+(.*)/s);
      if (match && match[1].length >= CONFIG.sentenceMinLength) {
        const sentence = match[1].trim();
        this.sentenceBuffer = match[2] || '';
        this.enqueueTTS(sentence);
        return;
      }

      // Check for paragraph break
      const nlMatch = this.sentenceBuffer.match(/^(.*?\n\n)(.*)/s);
      if (nlMatch && nlMatch[1].trim().length >= CONFIG.sentenceMinLength) {
        const sentence = nlMatch[1].trim();
        this.sentenceBuffer = nlMatch[2] || '';
        this.enqueueTTS(sentence);
      }
    },

    // ===== TTS QUEUE =====

    enqueueTTS(text) {
      if (!text || text.length < 2) return;

      const abortController = new AbortController();
      const item = {
        text,
        abortController,
        audioBuffer: null,
        status: 'pending' // pending → fetching → ready → playing
      };

      this.ttsQueue.push(item);
      this.ttsAbortControllers.push(abortController);

      console.log(`[VoiceEngine] TTS enqueued: "${text.substring(0, 40)}..." (queue: ${this.ttsQueue.length})`);

      // Start fetching if under the in-flight limit
      this._processTTSQueue();
    },

    async _processTTSQueue() {
      const inFlight = this.ttsQueue.filter(i => i.status === 'fetching').length;
      const pending = this.ttsQueue.filter(i => i.status === 'pending');

      for (let i = 0; i < Math.min(pending.length, CONFIG.ttsMaxInFlight - inFlight); i++) {
        this.fetchTTSChunk(pending[i]);
      }
    },

    async fetchTTSChunk(item) {
      if (item.status !== 'pending') return;
      item.status = 'fetching';

      if (!this._timestamps.tts_first_fetch) {
        this._timestamps.tts_first_fetch = performance.now();
      }

      try {
        const resp = await fetch(CONFIG.ttsEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: CONFIG.ttsModel,
            input: item.text,
            voice: CONFIG.ttsVoice,
            response_format: CONFIG.ttsFormat
          }),
          signal: item.abortController.signal
        });

        if (!resp.ok) throw new Error(`TTS error: ${resp.status}`);

        const blob = await resp.blob();
        const arrayBuffer = await blob.arrayBuffer();

        // Decode audio
        if (!this.ttsAudioContext || this.ttsAudioContext.state === 'closed') {
          this.ttsAudioContext = new (window.AudioContext || window.webkitAudioContext)();
          this.ttsSpeakAnalyser = this.ttsAudioContext.createAnalyser();
          this.ttsSpeakAnalyser.fftSize = 256;
          this.ttsSpeakAnalyser.connect(this.ttsAudioContext.destination);
        }

        item.audioBuffer = await this.ttsAudioContext.decodeAudioData(arrayBuffer);
        item.status = 'ready';

        if (!this._timestamps.tts_first_ready) {
          this._timestamps.tts_first_ready = performance.now();
          this._measure('first_text_to_first_audio');
        }

        // Try to play if nothing is playing
        this.playNextChunk();

        // Continue processing queue
        this._processTTSQueue();

      } catch (err) {
        if (err.name === 'AbortError') return; // barge-in
        console.error('[VoiceEngine] TTS fetch error:', err);
        item.status = 'ready'; // skip this chunk
        item.audioBuffer = null;
        this.playNextChunk();
      }
    },

    playNextChunk() {
      // Find first ready chunk
      while (this.ttsQueue.length > 0 && this.ttsQueue[0].status === 'ready' && !this.ttsQueue[0].audioBuffer) {
        this.ttsQueue.shift(); // skip failed chunks
      }

      if (this.ttsQueue.length === 0) {
        // All chunks played
        if (this.state === 'SPEAKING') {
          if (typeof stopSpeakingAnimation === 'function') stopSpeakingAnimation();
          if (typeof resetHelmetPulse === 'function') resetHelmetPulse();

          if (window.walkieTalkieMode) {
            this.transition('LISTENING');
          } else {
            this.deactivate();
          }
        }
        return;
      }

      const item = this.ttsQueue[0];
      if (item.status !== 'ready' || !item.audioBuffer) return; // wait for fetch

      // Transition to SPEAKING on first chunk
      if (this.state === 'THINKING') {
        this.transition('SPEAKING');
        this._measure('end_of_turn_to_first_phoneme');
      }

      item.status = 'playing';
      this.ttsQueue.shift();

      const source = this.ttsAudioContext.createBufferSource();
      source.buffer = item.audioBuffer;
      source.connect(this.ttsSpeakAnalyser);
      this.currentAudioSource = source;

      const startTime = Math.max(
        this.ttsAudioContext.currentTime,
        this.nextPlayTime || 0
      );
      source.start(startTime);
      this.nextPlayTime = startTime + item.audioBuffer.duration;

      // Animate helmet
      this._animateHelmet();

      source.onended = () => {
        this.currentAudioSource = null;
        this.playNextChunk();
      };
    },

    flushTTSQueue() {
      // Abort all pending TTS fetches
      this.ttsAbortControllers.forEach(c => {
        try { c.abort(); } catch (e) {}
      });
      this.ttsAbortControllers = [];

      // Stop current playback
      if (this.currentAudioSource) {
        try { this.currentAudioSource.stop(); } catch (e) {}
        this.currentAudioSource = null;
      }

      // Clear queue
      this.ttsQueue = [];
      this.nextPlayTime = 0;

      // Stop animations
      if (typeof stopSpeakingAnimation === 'function') stopSpeakingAnimation();
      if (typeof resetHelmetPulse === 'function') resetHelmetPulse();
    },

    _animateHelmet() {
      if (!this.ttsSpeakAnalyser || this.state !== 'SPEAKING') return;

      const bufferLength = this.ttsSpeakAnalyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const animate = () => {
        if (this.state !== 'SPEAKING' || !this.currentAudioSource) {
          if (typeof resetHelmetPulse === 'function') resetHelmetPulse();
          return;
        }
        requestAnimationFrame(animate);
        this.ttsSpeakAnalyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
        const avg = sum / bufferLength / 255;
        if (typeof pulseHelmetWithAudio === 'function') pulseHelmetWithAudio(avg);
      };
      requestAnimationFrame(animate);
    },

    // ===== VAD =====

    async initVAD() {
      if (typeof vad === 'undefined' || !vad.MicVAD) {
        console.warn('[VoiceEngine] VAD library not loaded, using fallback');
        this.useFallbackSTT = true;
        this.metrics.fallbackVadFailCount++;
        return;
      }

      try {
        this.vadInstance = await vad.MicVAD.new({
          stream: this.micStream,
          positiveSpeechThreshold: CONFIG.vadPositiveSpeechThreshold,
          negativeSpeechThreshold: CONFIG.vadNegativeSpeechThreshold,
          minSpeechFrames: CONFIG.vadMinSpeechFrames,
          preSpeechPadFrames: CONFIG.vadPreSpeechPadFrames,
          redemptionFrames: CONFIG.vadRedemptionFrames,
          onSpeechStart: () => { this.onSpeechStart(); },
          onSpeechEnd: (audio) => { this.onSpeechEnd(audio); }
        });

        this.vadInstance.start();
        console.log('[VoiceEngine] VAD initialized');
      } catch (err) {
        console.warn('[VoiceEngine] VAD init failed:', err);
        this.useFallbackSTT = true;
        this.metrics.fallbackVadFailCount++;
      }
    },

    onSpeechStart() {
      console.log('[VoiceEngine] VAD: speech_start');

      if (this.state === 'SPEAKING' || this.state === 'THINKING') {
        this.bargeIn();
      }
    },

    onSpeechEnd(audio) {
      // Used only as fallback endpointing when STT doesn't provide turn_end
      // Primary endpointing is via AssemblyAI
      console.log('[VoiceEngine] VAD: speech_end');
    },

    // ===== BARGE-IN =====

    bargeIn() {
      if (this.state !== 'SPEAKING' && this.state !== 'THINKING') return;

      console.log('[VoiceEngine] BARGE-IN');
      this._clearTurnCommitTimer();
      this.metrics.bargeInCount++;

      // 1. Stop current TTS playback
      this.flushTTSQueue();

      // 2. Abort LLM fetch
      if (this.llmAbort) {
        this.llmAbort.abort();
        this.llmAbort = null;
      }

      // 3. Reset sentence buffer
      this.sentenceBuffer = '';

      // 4. Clear transcript for new turn
      this.sttTranscript = '';
      this.sttPartial = '';

      // 5. Transition back to LISTENING
      this.transition('LISTENING');
    },

    // ===== UI HELPERS =====

    _showRecordingUI() {
      const iw = document.getElementById('inputWrapper');
      const rr = document.getElementById('recordingRow');
      if (iw) iw.classList.add('hidden');
      if (rr) rr.classList.remove('hidden');

      // Hide cancel/send in voice engine mode (VAD handles everything)
      const cancelBtn = document.getElementById('cancelRecBtn');
      const sendBtn = document.getElementById('sendRecBtn');
      if (cancelBtn) cancelBtn.classList.add('walkie-hidden');
      if (sendBtn) sendBtn.classList.add('walkie-hidden');

      // Start waveform visualization using existing infrastructure
      if (typeof startWaveform === 'function') startWaveform();
    },

    _hideRecordingUI() {
      const iw = document.getElementById('inputWrapper');
      const rr = document.getElementById('recordingRow');
      if (iw) iw.classList.remove('hidden');
      if (rr) rr.classList.add('hidden');

      const cancelBtn = document.getElementById('cancelRecBtn');
      const sendBtn = document.getElementById('sendRecBtn');
      if (cancelBtn) cancelBtn.classList.remove('walkie-hidden');
      if (sendBtn) sendBtn.classList.remove('walkie-hidden');

      if (typeof stopWaveform === 'function') stopWaveform();
    },

    // ===== METRICS =====

    _mark(name) {
      this._timestamps[name] = performance.now();
    },

    _measure(metricName) {
      // Map metric names to timestamp pairs
      const pairs = {
        'vad_start_to_stt_open': ['stt_token_start', 'stt_token_end'],
        'llm_start_to_first_text': ['llm_start', 'llm_first_token'],
        'first_text_to_first_audio': ['tts_first_fetch', 'tts_first_ready'],
        'end_of_turn_to_first_phoneme': ['turn_committed', 'tts_first_ready']
      };

      const pair = pairs[metricName];
      if (pair && this._timestamps[pair[0]] && this._timestamps[pair[1]]) {
        const ms = this._timestamps[pair[1]] - this._timestamps[pair[0]];
        this.metrics[metricName] = ms;
        console.log(`[VoiceEngine] Metric ${metricName}: ${ms.toFixed(1)}ms`);
      }
    },

    getMetrics() {
      return { ...this.metrics, timestamps: { ...this._timestamps } };
    },

    resetMetrics() {
      this._timestamps = {};
      Object.keys(this.metrics).forEach(k => {
        if (typeof this.metrics[k] === 'number') this.metrics[k] = 0;
        else this.metrics[k] = null;
      });
    }
  };

  // Expose globally
  window.VoiceEngine = VoiceEngine;

})();
