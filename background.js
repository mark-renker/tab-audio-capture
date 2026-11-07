// background.js — Service worker that coordinates tab capture, offscreen
// document lifecycle, and downloads.

let recording = false;
let recordingStartTime = 0;
let recordingTabId = null;
let recordingTabTitle = '';
let recordingChannels = 2;
let pendingBlobUrl = null;

// ── Badge helpers ──────────────────────────────────────────────────────

function updateBadge() {
  if (recording) {
    chrome.action.setBadgeText({ text: 'REC' });
    chrome.action.setBadgeBackgroundColor({ color: '#e94560' });
    chrome.action.setBadgeTextColor({ color: '#ffffff' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
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

    case 'get-status':
      sendResponse({
        recording,
        startTime: recordingStartTime,
        tabTitle: recordingTabTitle,
        channels: recordingChannels,
        hasPendingBlob: !!pendingBlobUrl,
      });
      return false;

    case 'start-recording':
      handleStartRecording(message.streamId, message.tabId, message.tabTitle, sendResponse);
      return true;

    case 'stop-recording':
      handleStopRecording(sendResponse);
      return true;

    case 'retry-save':
      if (pendingBlobUrl) {
        handleWavReady(pendingBlobUrl, null);
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'No pending recording' });
      }
      return false;

    case 'offscreen-started':
      return false;

    case 'offscreen-stopped':
      if (stopTimeoutId) {
        clearTimeout(stopTimeoutId);
        stopTimeoutId = null;
      }
      recording = false;
      recordingTabId = null;
      recordingTabTitle = '';
      if (pendingStopResponse) {
        pendingStopResponse({ success: true });
        pendingStopResponse = null;
      }
      updateBadge();
      broadcastStatus();
      return false;

    case 'offscreen-wav-ready':
      handleWavReady(message.blobUrl, message.filename);
      return false;

    case 'offscreen-error':
      console.error('[background] Offscreen error:', message.error);
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
      recordingTabTitle = '';
      updateBadge();
      broadcastStatus();
      return false;

    case 'audio-level':
      chrome.runtime.sendMessage({
        type: 'audio-level-update',
        peak: message.peak,
      }).catch(() => {});
      return false;
  }
});

// ── Start recording ─────────────────────────────────────────────────────

async function handleStartRecording(streamId, tabId, tabTitle, sendResponse) {
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
    recordingTabTitle = tabTitle || '';

    await ensureOffscreen();
    await new Promise(r => setTimeout(r, 100));

    chrome.runtime.sendMessage({
      type: 'start-capture',
      target: 'offscreen',
      streamId,
    });

    recording = true;
    recordingStartTime = Date.now();

    updateBadge();
    sendResponse({ success: true });
    broadcastStatus();
  } catch (err) {
    console.error('[background] Start recording error:', err);
    sendResponse({ success: false, error: err.message });
  }
}

// ── Stop recording ──────────────────────────────────────────────────────

let pendingStopResponse = null;
let stopTimeoutId = null;

async function handleStopRecording(sendResponse) {
  try {
    if (!recording) {
      sendResponse({ success: false, error: 'Not recording' });
      return;
    }

    pendingStopResponse = sendResponse;

    stopTimeoutId = setTimeout(() => {
      console.warn('[background] Stop capture timeout - forcing state reset');
      if (pendingStopResponse) {
        pendingStopResponse({ success: false, error: 'Stop timed out' });
        pendingStopResponse = null;
      }
      recording = false;
      recordingTabId = null;
      recordingTabTitle = '';
      updateBadge();
      broadcastStatus();
      closeOffscreen().catch(() => {});
    }, 10000);

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

  // Store blobUrl so user can retry save if dialog is cancelled
  pendingBlobUrl = blobUrl;

  if (!filename) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    filename = `tab-capture_${timestamp}.wav`;
  }

  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    pendingBlobUrl = null;
    chrome.runtime.sendMessage({
      type: 'revoke-blob',
      target: 'offscreen',
      blobUrl,
    }).catch(() => {});
    closeOffscreen().catch(() => {});
  }

  try {
    chrome.runtime.sendMessage({ type: 'save-dialog-opening' }).catch(() => {});

    const downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename: filename || 'tab-capture.wav',
      saveAs: true,
    });

    const listener = (delta) => {
      if (delta.id === downloadId && delta.state) {
        if (delta.state.current === 'complete') {
          chrome.downloads.onChanged.removeListener(listener);
          chrome.runtime.sendMessage({ type: 'download-complete' }).catch(() => {});
          cleanup();
        } else if (delta.state.current === 'interrupted') {
          chrome.downloads.onChanged.removeListener(listener);
          // Keep pendingBlobUrl so user can retry
          chrome.runtime.sendMessage({ type: 'download-cancelled' }).catch(() => {});
        }
      }
    };
    chrome.downloads.onChanged.addListener(listener);

    // Fallback cleanup after 5 minutes
    setTimeout(() => {
      chrome.downloads.onChanged.removeListener(listener);
      cleanup();
    }, 300000);

  } catch (err) {
    console.error('[background] Download error:', err);
    // Keep pendingBlobUrl for retry on user-cancel errors
    if (!err.message?.includes('user')) {
      cleanup();
    }
  }
}

// ── Broadcast status to popup ───────────────────────────────────────────

function broadcastStatus() {
  chrome.runtime.sendMessage({
    type: 'recording-status',
    recording,
  }).catch(() => {});
}

// ── Clean up if the captured tab is closed ──────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  if (recording && tabId === recordingTabId) {
    // Send stop so offscreen encodes and saves whatever was captured
    chrome.runtime.sendMessage({
      type: 'stop-capture',
      target: 'offscreen',
    }).catch(() => {});
    recording = false;
    recordingTabId = null;
    recordingTabTitle = '';
    updateBadge();
    broadcastStatus();
    chrome.runtime.sendMessage({
      type: 'recording-error',
      error: 'Recorded tab was closed — saving captured audio',
    }).catch(() => {});
  }
});

// ── Keyboard shortcut handler ──────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-recording') return;

  if (recording) {
    handleStopRecording((resp) => {
      if (!resp?.success) {
        console.warn('[background] Shortcut stop failed:', resp?.error);
      }
    });
    return;
  }

  // Start recording the active tab
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) return;

    chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (streamId) => {
      if (chrome.runtime.lastError || !streamId) return;
      handleStartRecording(streamId, tab.id, tab.title || tab.url, () => {});
    });
  } catch (err) {
    console.error('[background] Shortcut start error:', err);
  }
});
