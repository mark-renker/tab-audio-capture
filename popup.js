// popup.js — Handles UI state and communicates with the service worker.
// IMPORTANT: chrome.tabCapture.getMediaStreamId must be called here in the
// popup context (which has user-gesture context) rather than in the service
// worker, because the popup open + button click constitutes the user gesture.

const btn = document.getElementById('recordBtn');
const btnLabel = document.getElementById('btnLabel');
const btnIcon = document.getElementById('btnIcon');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const timerEl = document.getElementById('timer');

let isRecording = false;
let timerInterval = null;
let startTime = 0;

// ── Helpers ──────────────────────────────────────────────────────────────

function formatTime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function setUI(recording) {
  isRecording = recording;
  if (recording) {
    btn.className = 'recording';
    btnLabel.textContent = 'Stop';
    btnIcon.innerHTML = '<rect x="6" y="6" width="12" height="12" rx="2"/>';
    statusDot.classList.add('recording');
    statusText.textContent = 'Recording\u2026';
  } else {
    btn.className = 'idle';
    btnLabel.textContent = 'Record';
    btnIcon.innerHTML = '<circle cx="12" cy="12" r="8"/>';
    statusDot.classList.remove('recording');
    statusText.textContent = 'Ready to record';
    timerEl.textContent = '00:00:00';
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function startTimer() {
  startTime = Date.now();
  timerInterval = setInterval(() => {
    timerEl.textContent = formatTime(Date.now() - startTime);
  }, 250);
}

// ── On popup open, ask the service worker for current state ─────────────

chrome.runtime.sendMessage({ type: 'get-status' }, (resp) => {
  if (chrome.runtime.lastError) {
    setUI(false);
    return;
  }
  if (resp && resp.recording) {
    setUI(true);
    if (resp.startTime) {
      startTime = resp.startTime;
      timerInterval = setInterval(() => {
        timerEl.textContent = formatTime(Date.now() - startTime);
      }, 250);
    }
  } else {
    setUI(false);
  }
});

// ── Button click ────────────────────────────────────────────────────────

btn.addEventListener('click', async () => {
  btn.disabled = true;

  if (!isRecording) {
    // === START RECORDING ===
    try {
      // 1. Get the active tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) {
        statusText.textContent = 'No active tab found';
        btn.disabled = false;
        return;
      }

      if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
        statusText.textContent = 'Cannot capture this page';
        btn.disabled = false;
        return;
      }

      // 2. Get a stream ID — MUST be called from popup (user gesture context)
      const streamId = await new Promise((resolve, reject) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (id) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (!id) {
            reject(new Error('No stream ID returned'));
          } else {
            resolve(id);
          }
        });
      });

      // 3. Send the stream ID to the service worker, which will forward it
      //    to the offscreen document
      chrome.runtime.sendMessage({
        type: 'start-recording',
        streamId,
        tabId: tab.id,
      }, (resp) => {
        btn.disabled = false;
        if (chrome.runtime.lastError) {
          statusText.textContent = 'Error: ' + chrome.runtime.lastError.message;
          return;
        }
        if (resp && resp.success) {
          setUI(true);
          startTimer();
        } else {
          statusText.textContent = resp?.error || 'Failed to start recording';
        }
      });

    } catch (err) {
      btn.disabled = false;
      statusText.textContent = 'Error: ' + err.message;
    }

  } else {
    // === STOP RECORDING ===
    statusText.textContent = 'Stopping\u2026';

    chrome.runtime.sendMessage({ type: 'stop-recording' }, (resp) => {
      btn.disabled = false;
      if (chrome.runtime.lastError) {
        statusText.textContent = 'Error: ' + chrome.runtime.lastError.message;
        // Don't reset UI - recording may still be active
        return;
      }
      if (resp && resp.success) {
        // Only now is recording actually stopped - update UI
        setUI(false);
        statusText.textContent = 'Encoding WAV\u2026';
        setTimeout(() => {
          if (statusText.textContent === 'Encoding WAV\u2026') {
            statusText.textContent = 'Ready to record';
          }
        }, 10000);
      } else {
        // Stop failed - recording may still be active, don't change UI state
        statusText.textContent = resp?.error || 'Failed to stop recording';
      }
    });
  }
});

// ── Listen for status updates from background ───────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'recording-status') {
    // Only start a new timer if we weren't already tracking one
    // and if background provides the start time
    if (message.recording && !isRecording) {
      setUI(true);
      // Request updated start time from background
      chrome.runtime.sendMessage({ type: 'get-status' }, (resp) => {
        if (resp && resp.recording && resp.startTime) {
          startTime = resp.startTime;
          if (!timerInterval) {
            timerInterval = setInterval(() => {
              timerEl.textContent = formatTime(Date.now() - startTime);
            }, 250);
          }
        }
      });
    } else if (!message.recording && isRecording) {
      setUI(false);
    }
  }
  if (message.type === 'download-complete') {
    statusText.textContent = 'WAV saved';
    setTimeout(() => {
      statusText.textContent = 'Ready to record';
    }, 2500);
  }
  if (message.type === 'recording-error') {
    setUI(false);
    statusText.textContent = 'Error: ' + (message.error || 'Unknown');
  }
});
