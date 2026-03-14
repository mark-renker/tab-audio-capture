// background.js — Service worker that coordinates tab capture, offscreen
// document lifecycle, and downloads.
//
// The popup obtains the streamId (user gesture context) and sends it here.
// This worker manages the offscreen document and handles the download.

let recording = false;
let recordingStartTime = 0;
let recordingTabId = null;

// ── Offscreen document management ───────────────────────────────────────

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({});
  const exists = contexts.some(c => c.contextType === 'OFFSCREEN_DOCUMENT');
  if (!exists) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Capture tab audio via Web Audio API and encode WAV',
    });
  }
}

async function closeOffscreen() {
  const contexts = await chrome.runtime.getContexts({});
  const exists = contexts.some(c => c.contextType === 'OFFSCREEN_DOCUMENT');
  if (exists) {
    await chrome.offscreen.closeDocument();
  }
}

// ── Message router ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {

    // ---- Popup asks for current state ----
    case 'get-status':
      sendResponse({ recording, startTime: recordingStartTime });
      return false;

    // ---- Popup sends streamId to start recording ----
    case 'start-recording':
      handleStartRecording(message.streamId, message.tabId, sendResponse);
      return true; // async sendResponse

    // ---- Popup asks to stop recording ----
    case 'stop-recording':
      handleStopRecording(sendResponse);
      return true;

    // ---- Offscreen sends back a blob URL when recording finishes ----
    case 'offscreen-wav-ready':
      handleWavReady(message.blobUrl, message.filename);
      return false;

    // ---- Offscreen reports an error ----
    case 'offscreen-error':
      console.error('[background] Offscreen error:', message.error);
      recording = false;
      recordingTabId = null;
      broadcastStatus();
      return false;
  }
});

// ── Start recording ─────────────────────────────────────────────────────

async function handleStartRecording(streamId, tabId, sendResponse) {
  try {
    if (recording) {
      sendResponse({ success: false, error: 'Already recording' });
      return;
    }

    if (!streamId) {
      sendResponse({ success: false, error: 'No stream ID provided' });
      return;
    }

    recordingTabId = tabId;

    // Ensure the offscreen document is alive
    await ensureOffscreen();

    // Give offscreen a moment to register its listener
    // (in practice this is nearly instant, but a tiny delay prevents race conditions)
    await new Promise(r => setTimeout(r, 100));

    // Forward the stream ID to the offscreen document
    chrome.runtime.sendMessage({
      type: 'start-capture',
      target: 'offscreen',
      streamId,
    });

    recording = true;
    recordingStartTime = Date.now();

    sendResponse({ success: true });
    broadcastStatus();
  } catch (err) {
    console.error('[background] Start recording error:', err);
    sendResponse({ success: false, error: err.message });
  }
}

// ── Stop recording ──────────────────────────────────────────────────────

async function handleStopRecording(sendResponse) {
  try {
    if (!recording) {
      sendResponse({ success: false, error: 'Not recording' });
      return;
    }

    // Tell offscreen to stop and encode WAV
    chrome.runtime.sendMessage({
      type: 'stop-capture',
      target: 'offscreen',
    });

    recording = false;
    recordingTabId = null;

    sendResponse({ success: true });
    broadcastStatus();
  } catch (err) {
    console.error('[background] Stop recording error:', err);
    sendResponse({ success: false, error: err.message });
  }
}

// ── Handle completed WAV from offscreen ─────────────────────────────────

async function handleWavReady(blobUrl, filename) {
  try {
    // Use chrome.downloads to let the user pick a save location
    const downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename: filename || 'tab-capture.wav',
      saveAs: true, // show "Save As" dialog
    });

    // Monitor download status for cleanup
    chrome.downloads.onChanged.addListener(function listener(delta) {
      if (delta.id === downloadId && delta.state) {
        if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
          chrome.downloads.onChanged.removeListener(listener);
          // Notify popup
          chrome.runtime.sendMessage({ type: 'download-complete' }).catch(() => {});
          // Close the offscreen document to free resources
          closeOffscreen().catch(() => {});
        }
      }
    });
  } catch (err) {
    console.error('[background] Download error:', err);
  }
}

// ── Broadcast status to popup ───────────────────────────────────────────

function broadcastStatus() {
  chrome.runtime.sendMessage({
    type: 'recording-status',
    recording,
  }).catch(() => {
    // Popup may be closed, that's fine
  });
}

// ── Clean up if the captured tab is closed ──────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  if (recording && tabId === recordingTabId) {
    chrome.runtime.sendMessage({
      type: 'stop-capture',
      target: 'offscreen',
    }).catch(() => {});
    recording = false;
    recordingTabId = null;
    broadcastStatus();
  }
});
