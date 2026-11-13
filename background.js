// background.js — Service worker that coordinates tab capture, offscreen
// document lifecycle, and downloads.
//
// The popup obtains the streamId (user gesture context) and sends it here.
// This worker manages the offscreen document and handles the download.

let recording = false;
let recordingStartTime = 0;
let recordingTabId = null;

const DEFAULT_SETTINGS = {
  saveAs: true,
  openFolderAfterSave: false,
  subfolder: '',
  filenamePrefix: 'tab-capture_',
};

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

function sanitizeSubfolder(input) {
  let s = (input || '').trim();
  if (!s) return '';
  s = s.replace(/\\\\/g, '/');
  s = s.replace(/\\.+/g, '.');
  s = s.replace(/^\\/+/, '');
  if (s.includes('..')) s = s.replace(/\\.\\./g, '');
  if (s && !s.endsWith('/')) s += '/';
  return s;
}

function withSubfolder(filename, subfolder) {
  const folder = sanitizeSubfolder(subfolder);
  if (!folder) return filename;
  return folder + filename.replace(/^\\/+/, '');
}

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

    case 'open-downloads-settings':
      chrome.tabs.create({ url: 'chrome://settings/downloads' }).catch(() => {});
      sendResponse({ success: true });
      return false;

    // ---- Offscreen confirms capture started ----
    case 'offscreen-started':
      // Capture actually started - state is already set, just log
      console.log('[background] Offscreen confirmed capture started');
      return false;

    // ---- Offscreen confirms it stopped and is encoding ----
    case 'offscreen-stopped':
      console.log('[background] Offscreen confirmed stop');
      // Clear timeout since offscreen responded
      if (stopTimeoutId) {
        clearTimeout(stopTimeoutId);
        stopTimeoutId = null;
      }
      // Now we can safely update state
      recording = false;
      recordingTabId = null;
      // Respond to the pending stop request
      if (pendingStopResponse) {
        pendingStopResponse({ success: true });
        pendingStopResponse = null;
      }
      broadcastStatus();
      return false;

    // ---- Offscreen sends back a blob URL when recording finishes ----
    case 'offscreen-wav-ready':
      handleWavReady(message.blobUrl, message.filename);
      return false;

    // ---- Offscreen reports an error ----
    case 'offscreen-error':
      console.error('[background] Offscreen error:', message.error);
      // Clear any pending stop
      if (stopTimeoutId) {
        clearTimeout(stopTimeoutId);
        stopTimeoutId = null;
      }
      if (pendingStopResponse) {
        pendingStopResponse({ success: false, error: message.error });
        pendingStopResponse = null;
      }
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

// Pending stop request - we wait for offscreen to confirm before responding
let pendingStopResponse = null;
let stopTimeoutId = null;

async function handleStopRecording(sendResponse) {
  try {
    if (!recording) {
      sendResponse({ success: false, error: 'Not recording' });
      return;
    }

    // Store the response callback - we'll call it when offscreen confirms
    pendingStopResponse = sendResponse;

    // Set a timeout in case offscreen doesn't respond
    stopTimeoutId = setTimeout(() => {
      console.warn('[background] Stop capture timeout - forcing state reset');
      if (pendingStopResponse) {
        pendingStopResponse({ success: false, error: 'Stop timed out' });
        pendingStopResponse = null;
      }
      recording = false;
      recordingTabId = null;
      broadcastStatus();
      closeOffscreen().catch(() => {});
    }, 10000); // 10 second timeout

    // Tell offscreen to stop and encode WAV
    chrome.runtime.sendMessage({
      type: 'stop-capture',
      target: 'offscreen',
    });

  } catch (err) {
    console.error('[background] Stop recording error:', err);
    if (pendingStopResponse) {
      pendingStopResponse({ success: false, error: err.message });
      pendingStopResponse = null;
    }
    if (stopTimeoutId) {
      clearTimeout(stopTimeoutId);
      stopTimeoutId = null;
    }
  }
}

// ── Handle completed WAV from offscreen ─────────────────────────────────

async function handleWavReady(blobUrl, filename) {
  let cleanedUp = false;

  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    // Tell offscreen to revoke the blob URL to free memory
    chrome.runtime.sendMessage({
      type: 'revoke-blob',
      target: 'offscreen',
      blobUrl,
    }).catch(() => {});
    // Close the offscreen document to free resources
    closeOffscreen().catch(() => {});
  }

  try {
    const settings = await getSettings();

    // If offscreen didn't provide one, use a safe default.
    const baseName = filename || 'tab-capture.wav';
    const targetName = withSubfolder(baseName, settings.subfolder);

    // Use chrome.downloads to let the user pick a save location
    const downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename: targetName,
      saveAs: !!settings.saveAs,
    });

    // Monitor download status for cleanup
    const listener = (delta) => {
      if (delta.id === downloadId && delta.state) {
        if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
          chrome.downloads.onChanged.removeListener(listener);
          // Notify popup
          if (delta.state.current === 'complete') {
            chrome.runtime.sendMessage({ type: 'download-complete' }).catch(() => {});
            if (settings.openFolderAfterSave) {
              chrome.downloads.show(downloadId);
            }
          } else {
            chrome.runtime.sendMessage({ type: 'download-error', error: 'Download interrupted' }).catch(() => {});
          }
          cleanup();
        }
      }
    };
    chrome.downloads.onChanged.addListener(listener);

    // Fallback cleanup after 2 minutes in case dialog is cancelled
    // (cancelled dialogs don't always trigger state changes)
    setTimeout(() => {
      chrome.downloads.onChanged.removeListener(listener);
      cleanup();
    }, 120000);

  } catch (err) {
    console.error('[background] Download error:', err);
    chrome.runtime.sendMessage({ type: 'download-error', error: err.message }).catch(() => {});
    cleanup();
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
