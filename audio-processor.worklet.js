/**
 * AudioWorklet Processor for SENNA Voice Engine
 * Resamples microphone audio from native sample rate (44.1/48kHz) to 16kHz
 * Converts Float32 to Int16 PCM and posts buffers via MessagePort
 */
class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    this._targetSampleRate = 16000;
    this._ratio = sampleRate / this._targetSampleRate;
    this._resampleIndex = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) return true;

    const channelData = input[0]; // mono

    // Resample: pick samples at ratio intervals
    for (let i = 0; i < channelData.length; i++) {
      this._resampleIndex += 1;
      if (this._resampleIndex >= this._ratio) {
        this._resampleIndex -= this._ratio;

        // Clamp and convert Float32 [-1,1] to Int16
        const s = Math.max(-1, Math.min(1, channelData[i]));
        const int16 = s < 0 ? s * 0x8000 : s * 0x7FFF;
        this._buffer.push(int16);
      }
    }

    // Post ~100ms chunks (1600 samples at 16kHz)
    if (this._buffer.length >= 1600) {
      const chunk = new Int16Array(this._buffer.splice(0, 1600));
      this.port.postMessage({ pcm16: chunk }, [chunk.buffer]);
    }

    return true;
  }
}

registerProcessor('audio-processor', AudioProcessor);
