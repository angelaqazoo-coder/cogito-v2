// audio-processor.js — AudioWorklet that converts Float32 → PCM16
// Loaded by the browser as a Worklet module, NOT as a regular ES module.

class PCM16Processor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    this._chunkSize = 2048; // samples per chunk (~128ms at 16kHz)
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const samples = input[0]; // Float32Array
    for (let i = 0; i < samples.length; i++) {
      this._buffer.push(samples[i]);
    }

    while (this._buffer.length >= this._chunkSize) {
      const chunk = this._buffer.splice(0, this._chunkSize);
      const pcm16 = this._toPCM16(chunk);
      this.port.postMessage({ pcm16 }, [pcm16.buffer]);
    }

    return true;
  }

  _toPCM16(floats) {
    const out = new Int16Array(floats.length);
    for (let i = 0; i < floats.length; i++) {
      const s = Math.max(-1, Math.min(1, floats[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }
}

registerProcessor('pcm16-processor', PCM16Processor);
