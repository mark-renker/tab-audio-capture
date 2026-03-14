// pcm-capture-processor.js — AudioWorkletProcessor that runs on the
// audio rendering thread. Receives 128-sample blocks from the Web Audio
// graph and forwards copies to the main thread via MessagePort.

class PCMCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._active = true;

    // Listen for stop signal from the main thread
    this.port.onmessage = (event) => {
      if (event.data.type === 'stop') {
        this._active = false;
      }
    };
  }

  process(inputs, outputs, parameters) {
    // inputs[0] is our input; each sub-array is a channel (Float32Array, 128 samples)
    const input = inputs[0];
    if (!this._active || !input || input.length === 0) {
      return this._active; // returning false removes the node from the graph
    }

    const numChannels = input.length;
    const blockSize = input[0].length; // typically 128

    if (numChannels >= 2) {
      // Stereo: interleave L/R
      const left = input[0];
      const right = input[1];
      const interleaved = new Float32Array(blockSize * 2);
      for (let i = 0; i < blockSize; i++) {
        interleaved[i * 2] = left[i];
        interleaved[i * 2 + 1] = right[i];
      }
      // Transfer the buffer to avoid copying overhead
      this.port.postMessage(
        { type: 'pcm', samples: interleaved, channels: 2 },
        [interleaved.buffer]
      );
    } else {
      // Mono
      const mono = new Float32Array(input[0]);
      this.port.postMessage(
        { type: 'pcm', samples: mono, channels: 1 },
        [mono.buffer]
      );
    }

    // Pass audio through to output (not strictly needed since we use a
    // silent gain node downstream, but good practice)
    for (let ch = 0; ch < numChannels; ch++) {
      if (outputs[0] && outputs[0][ch]) {
        outputs[0][ch].set(input[ch]);
      }
    }

    return this._active;
  }
}

registerProcessor('pcm-capture-processor', PCMCaptureProcessor);
