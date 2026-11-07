// pcm-capture-processor.js — AudioWorkletProcessor that runs on the
// audio rendering thread. Receives 128-sample blocks from the Web Audio
// graph and forwards copies to the main thread via MessagePort.

class PCMCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._active = true;
    this._levelCounter = 0;

    this.port.onmessage = (event) => {
      if (event.data.type === 'stop') {
        this._active = false;
      }
    };
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!this._active || !input || input.length === 0) {
      return this._active;
    }

    const numChannels = input.length;
    const blockSize = input[0].length;

    // Compute peak level across all channels every ~12 blocks (~35ms at 44.1kHz)
    this._levelCounter++;
    if (this._levelCounter >= 12) {
      this._levelCounter = 0;
      let peak = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        for (let i = 0; i < blockSize; i++) {
          const abs = Math.abs(input[ch][i]);
          if (abs > peak) peak = abs;
        }
      }
      this.port.postMessage({ type: 'level', peak });
    }

    if (numChannels >= 2) {
      const left = input[0];
      const right = input[1];
      const interleaved = new Float32Array(blockSize * 2);
      for (let i = 0; i < blockSize; i++) {
        interleaved[i * 2] = left[i];
        interleaved[i * 2 + 1] = right[i];
      }
      this.port.postMessage(
        { type: 'pcm', samples: interleaved, channels: 2 },
        [interleaved.buffer]
      );
    } else {
      const mono = new Float32Array(input[0]);
      this.port.postMessage(
        { type: 'pcm', samples: mono, channels: 1 },
        [mono.buffer]
      );
    }

    for (let ch = 0; ch < numChannels; ch++) {
      if (outputs[0] && outputs[0][ch]) {
        outputs[0][ch].set(input[ch]);
      }
    }

    return this._active;
  }
}

registerProcessor('pcm-capture-processor', PCMCaptureProcessor);
