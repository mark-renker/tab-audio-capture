// offscreen.js — Runs inside the offscreen document.
// Captures tab audio as raw PCM float32 via AudioWorkletNode,
// then encodes to 16-bit WAV on stop.

let audioContext = null;
let mediaStream = null;
let sourceNode = null;
let workletNode = null;
let silentGain = null;
let pcmChunks = [];      // Array of Float32Array (interleaved stereo or mono)
let channelCount = 2;
let sampleRate = 44100;
let isCapturing = false;
let activeSettings = null;

const DEFAULT_SETTINGS = {
  filenamePrefix: 'tab-capture_',
  sampleRate: 44100,
  channelMode: 'stereo', // 'stereo' | 'mono'
  trimSilence: true,
  silenceThresholdDb: -55,
  fadeMs: 10,
  normalize: true,
  normalizeTargetDb: -1.0,
};

async function loadSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

// ── Message handler ─────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  if (message.type === 'start-capture') {
    startCapture(message.streamId);
  }

  if (message.type === 'stop-capture') {
    stopCapture();
  }

  if (message.type === 'revoke-blob' && message.blobUrl) {
    try {
      URL.revokeObjectURL(message.blobUrl);
      console.log('[offscreen] Blob URL revoked');
    } catch (e) {
      console.warn('[offscreen] Failed to revoke blob URL:', e);
    }
  }
});

// ── Start capturing ─────────────────────────────────────────────────────

async function startCapture(streamId) {
  try {
    if (isCapturing) return;

    // Snapshot settings at start so stop uses consistent values.
    activeSettings = await loadSettings();

    // 1. Redeem the stream ID for a real MediaStream (audio only)
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });

    const audioTrack = mediaStream.getAudioTracks()[0];
    if (!audioTrack) {
      throw new Error('No audio track in captured stream');
    }

    // 2. Set up Web Audio graph at requested sample rate
    const requestedSampleRate = activeSettings?.sampleRate === 48000 ? 48000 : 44100;
    audioContext = new AudioContext({ sampleRate: requestedSampleRate });
    sampleRate = audioContext.sampleRate;

    sourceNode = audioContext.createMediaStreamSource(mediaStream);

    // Route captured audio back to speakers so the user still hears the tab.
    // This prevents Chrome from muting the tab during capture.
    sourceNode.connect(audioContext.destination);

    // Determine channel count from the source
    channelCount = Math.min(sourceNode.channelCount || 2, 2); // cap at stereo

    // 3. Load the AudioWorklet processor module
    await audioContext.audioWorklet.addModule('pcm-capture-processor.js');

    // 4. Create the worklet node
    workletNode = new AudioWorkletNode(audioContext, 'pcm-capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: channelCount,
      channelCountMode: 'explicit',
    });

    pcmChunks = [];

    // 5. Listen for PCM data from the worklet's audio thread
    workletNode.port.onmessage = (event) => {
      if (event.data.type === 'pcm' && isCapturing) {
        pcmChunks.push(event.data.samples);
        // Update channelCount from the actual data if needed
        if (event.data.channels) {
          channelCount = event.data.channels;
        }
      }
    };

    // 6. Connect: source → workletNode → silentGain → destination
    //    The worklet must be connected to a destination to keep processing,
    //    but we don't want it to output audio (source is already connected
    //    directly to destination for playback). A zero-gain node silences
    //    the worklet path so the user hears the tab at normal volume.
    silentGain = audioContext.createGain();
    silentGain.gain.value = 0;

    sourceNode.connect(workletNode);
    workletNode.connect(silentGain);
    silentGain.connect(audioContext.destination);

    isCapturing = true;
    console.log('[offscreen] Capture started (AudioWorklet) — sr:', sampleRate, 'ch:', channelCount);

    // Confirm to background that capture actually started
    chrome.runtime.sendMessage({ type: 'offscreen-started' });

  } catch (err) {
    console.error('[offscreen] Capture start error:', err);
    chrome.runtime.sendMessage({
      type: 'offscreen-error',
      error: err.message,
    });
  }
}

// ── Stop capturing and encode WAV ───────────────────────────────────────

function stopCapture() {
  // Always send confirmation that we received the stop command
  // This is critical - background.js waits for this before updating state

  if (!isCapturing) {
    console.warn('[offscreen] stopCapture called but not capturing');
    // Still send stopped confirmation so background can update state
    chrome.runtime.sendMessage({ type: 'offscreen-stopped' });
    return;
  }

  isCapturing = false;

  // Tell the worklet processor to stop
  if (workletNode) {
    workletNode.port.postMessage({ type: 'stop' });
  }

  // Disconnect and clean up Web Audio graph
  try {
    if (workletNode) workletNode.disconnect();
    if (silentGain) silentGain.disconnect();
    if (sourceNode) sourceNode.disconnect();
    if (audioContext) audioContext.close();
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop());
    }
  } catch (e) {
    console.warn('[offscreen] Cleanup warning:', e);
  }

  // Reset node references
  workletNode = null;
  silentGain = null;
  sourceNode = null;
  audioContext = null;
  mediaStream = null;

  // Send confirmation that capture has stopped BEFORE encoding
  // This lets the UI update immediately while we encode
  chrome.runtime.sendMessage({ type: 'offscreen-stopped' });

  // Merge all PCM chunks into one contiguous Float32Array
  const totalLength = pcmChunks.reduce((sum, c) => sum + c.length, 0);
  if (totalLength === 0) {
    console.warn('[offscreen] No audio data captured');
    chrome.runtime.sendMessage({ type: 'offscreen-error', error: 'No audio data' });
    return;
  }

  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of pcmChunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  pcmChunks = []; // free memory

  console.log('[offscreen] Encoding WAV — samples:', totalLength, 'channels:', channelCount);

  const settings = activeSettings || DEFAULT_SETTINGS;
  const processed = processAudio(merged, sampleRate, channelCount, settings);

  // Encode to WAV
  const wavBlob = encodeWAV(processed.samples, processed.sampleRate, processed.channelCount);

  // Create a blob URL and send it back to the service worker
  const blobUrl = URL.createObjectURL(wavBlob);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const prefix = (settings.filenamePrefix || DEFAULT_SETTINGS.filenamePrefix || 'tab-capture_').trim() || 'tab-capture_';
  const filename = `${prefix}${timestamp}.wav`;

  chrome.runtime.sendMessage({
    type: 'offscreen-wav-ready',
    blobUrl,
    filename,
  });
}

// ── Audio processing (sampling-focused) ──────────────────────────────────

function dbToLinear(db) {
  return Math.pow(10, db / 20);
}

function computePeak(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  return peak;
}

function applyGain(samples, gain) {
  if (!Number.isFinite(gain) || gain === 1) return samples;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
  return out;
}

function downmixToMono(interleaved, inChannels) {
  if (inChannels === 1) return interleaved;
  const frames = Math.floor(interleaved.length / inChannels);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const base = f * inChannels;
    for (let c = 0; c < inChannels; c++) sum += interleaved[base + c];
    out[f] = sum / inChannels;
  }
  return out;
}

function trimSilenceInterleaved(interleaved, sr, channels, thresholdLinear) {
  const frames = Math.floor(interleaved.length / channels);
  if (frames === 0) return interleaved;

  const thr = Math.max(0, thresholdLinear);

  let startFrame = 0;
  while (startFrame < frames) {
    const base = startFrame * channels;
    let maxAbs = 0;
    for (let c = 0; c < channels; c++) {
      const a = Math.abs(interleaved[base + c]);
      if (a > maxAbs) maxAbs = a;
    }
    if (maxAbs > thr) break;
    startFrame++;
  }

  let endFrame = frames - 1;
  while (endFrame >= startFrame) {
    const base = endFrame * channels;
    let maxAbs = 0;
    for (let c = 0; c < channels; c++) {
      const a = Math.abs(interleaved[base + c]);
      if (a > maxAbs) maxAbs = a;
    }
    if (maxAbs > thr) break;
    endFrame--;
  }

  const newFrames = Math.max(0, endFrame - startFrame + 1);
  if (newFrames <= 0) return interleaved;
  const out = new Float32Array(newFrames * channels);
  out.set(interleaved.subarray(startFrame * channels, (endFrame + 1) * channels));
  return out;
}

function applyFadesInterleaved(interleaved, sr, channels, fadeMs) {
  const fadeSamples = Math.max(0, Math.round((sr * Math.max(0, fadeMs)) / 1000));
  if (fadeSamples === 0) return interleaved;

  const frames = Math.floor(interleaved.length / channels);
  const fadeFrames = Math.min(fadeSamples, Math.floor(frames / 2));
  if (fadeFrames <= 0) return interleaved;

  const out = new Float32Array(interleaved);

  for (let f = 0; f < fadeFrames; f++) {
    const g = (f + 1) / fadeFrames;
    const base = f * channels;
    for (let c = 0; c < channels; c++) out[base + c] *= g;
  }

  for (let f = 0; f < fadeFrames; f++) {
    const g = (fadeFrames - f) / fadeFrames;
    const frameIndex = frames - 1 - f;
    const base = frameIndex * channels;
    for (let c = 0; c < channels; c++) out[base + c] *= g;
  }

  return out;
}

function processAudio(samples, sr, channels, settings) {
  let outSamples = samples;
  let outChannels = channels;
  const outSampleRate = sr;

  if (settings.trimSilence) {
    const thrDb = Number.isFinite(settings.silenceThresholdDb) ? settings.silenceThresholdDb : DEFAULT_SETTINGS.silenceThresholdDb;
    const thrLin = dbToLinear(thrDb);
    outSamples = trimSilenceInterleaved(outSamples, sr, outChannels, thrLin);
  }

  const fadeMs = Number.isFinite(settings.fadeMs) ? settings.fadeMs : DEFAULT_SETTINGS.fadeMs;
  if (fadeMs > 0) {
    outSamples = applyFadesInterleaved(outSamples, sr, outChannels, fadeMs);
  }

  if (settings.normalize) {
    const targetDb = Number.isFinite(settings.normalizeTargetDb) ? settings.normalizeTargetDb : DEFAULT_SETTINGS.normalizeTargetDb;
    const targetLin = dbToLinear(targetDb);
    const peak = computePeak(outSamples);
    if (peak > 0) {
      const gain = targetLin / peak;
      outSamples = applyGain(outSamples, gain);
    }
  }

  if (settings.channelMode === 'mono') {
    outSamples = downmixToMono(outSamples, outChannels);
    outChannels = 1;
  }

  return { samples: outSamples, sampleRate: outSampleRate, channelCount: outChannels };
}

// ── WAV encoder — float32 PCM → 16-bit little-endian WAV ───────────────

function encodeWAV(samples, sr, numChannels) {
  // samples is already interleaved if stereo
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sr * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);

  // ---- RIFF header ----
  writeString(view, 0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);       // file size - 8
  writeString(view, 8, 'WAVE');

  // ---- fmt sub-chunk ----
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);                  // sub-chunk size (PCM = 16)
  view.setUint16(20, 1, true);                   // audio format (1 = PCM)
  view.setUint16(22, numChannels, true);          // number of channels
  view.setUint32(24, sr, true);                   // sample rate
  view.setUint32(28, byteRate, true);             // byte rate
  view.setUint16(32, blockAlign, true);           // block align
  view.setUint16(34, bitsPerSample, true);        // bits per sample

  // ---- data sub-chunk ----
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);             // data size in bytes

  // ---- PCM samples: float32 [-1, 1] → int16 [-32768, 32767] ----
  let writeOffset = 44;
  for (let i = 0; i < samples.length; i++) {
    // Clamp to [-1, 1]
    let s = Math.max(-1, Math.min(1, samples[i]));
    // Convert to int16
    s = s < 0 ? s * 32768 : s * 32767;
    view.setInt16(writeOffset, s, true);
    writeOffset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
