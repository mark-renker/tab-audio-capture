// popup.js — Handles UI state and communicates with the service worker.

const btn = document.getElementById('recordBtn');
const btnLabel = document.getElementById('btnLabel');
const btnIcon = document.getElementById('btnIcon');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const timerEl = document.getElementById('timer');
const tabInfoEl = document.getElementById('tabInfo');
const levelMeter = document.getElementById('levelMeter');
const levelFill = document.getElementById('levelFill');
const fileSizeEl = document.getElementById('fileSize');
const saveBtn = document.getElementById('saveBtn');
const confirmOverlay = document.getElementById('confirmOverlay');
const confirmText = document.getElementById('confirmText');
const confirmStop = document.getElementById('confirmStop');
const confirmCancel = document.getElementById('confirmCancel');
const shortcutHint = document.getElementById('shortcutHint');

let isRecording = false;
let timerInterval = null;
let startTime = 0;
let channels = 2;

const CONFIRM_THRESHOLD_MS = 5 * 60 * 1000;

// ── Helpers ──────────────────────────────────────────────────────────────

function formatTime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function formatFileSize(bytes) {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function estimateFileSize(ms) {
  const seconds = ms / 1000;
  return Math.floor(seconds * 44100 * 2 * channels) + 44;
}

function updateFileSize() {
  if (!isRecording || !startTime) return;
  const elapsed = Date.now() - startTime;
  const bytes = estimateFileSize(elapsed);
  fileSizeEl.textContent = '~' + formatFileSize(bytes);
}

function setUI(recording, tabTitle) {
  isRecording = recording;
  if (recording) {
    btn.className = 'recording';
    btnLabel.textContent = 'Stop';
    btnIcon.innerHTML = '<rect x="6" y="6" width="12" height="12" rx="2"/>';
    statusDot.classList.add('recording');
    statusText.textContent = 'Recording…';
    levelMeter.classList.add('visible');
    fileSizeEl.classList.add('visible');
    if (tabTitle) {
      tabInfoEl.textContent = 'Recording: ' + tabTitle;
      tabInfoEl.classList.add('visible');
    }
    saveBtn.classList.remove('visible');
  } else {
    btn.className = 'idle';
    btnLabel.textContent = 'Record';
    btnIcon.innerHTML = '<circle cx="12" cy="12" r="8"/>';
    statusDot.classList.remove('recording');
    statusText.textContent = 'Ready to record';
    timerEl.textContent = '00:00:00';
    fileSizeEl.classList.remove('visible');
    tabInfoEl.classList.remove('visible');
    levelMeter.classList.remove('visible');
    levelFill.style.width = '0%';
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function startTimer() {
  startTime = Date.now();
  timerInterval = setInterval(() => {
    timerEl.textContent = formatTime(Date.now() - startTime);
    updateFileSize();
  }, 250);
}

function doStop() {
  btn.disabled = true;
  statusText.textContent = 'Stopping…';

  chrome.runtime.sendMessage({ type: 'stop-recording' }, (resp) => {
    btn.disabled = false;
    if (chrome.runtime.lastError) {
      statusText.textContent = 'Error: ' + chrome.runtime.lastError.message;
      return;
    }
    if (resp && resp.success) {
      setUI(false);
      statusText.textContent = 'Encoding WAV…';
      setTimeout(() => {
        if (statusText.textContent === 'Encoding WAV…') {
          statusText.textContent = 'Ready to record';
        }
      }, 10000);
    } else {
      statusText.textContent = resp?.error || 'Failed to stop recording';
    }
  });
}

// ── Show keyboard shortcut hint ─────────────────────────────────────────

chrome.commands?.getAll?.((commands) => {
  const toggle = commands?.find(c => c.name === 'toggle-recording');
  if (toggle?.shortcut) {
    shortcutHint.textContent = 'Shortcut: ' + toggle.shortcut;
  }
});

// ── On popup open, ask the service worker for current state ─────────────

chrome.runtime.sendMessage({ type: 'get-status' }, (resp) => {
  if (chrome.runtime.lastError) {
    setUI(false);
    return;
  }
  if (resp && resp.recording) {
    if (resp.channels) channels = resp.channels;
    setUI(true, resp.tabTitle);
    if (resp.startTime) {
      startTime = resp.startTime;
      timerInterval = setInterval(() => {
        timerEl.textContent = formatTime(Date.now() - startTime);
        updateFileSize();
      }, 250);
    }
  } else {
    setUI(false);
    if (resp && resp.hasPendingBlob) {
      saveBtn.classList.add('visible');
      statusText.textContent = 'Unsaved recording available';
    }
  }
});

// ── Record / Stop button ───────────────────────────────────────────────

btn.addEventListener('click', async () => {
  if (!isRecording) {
    // === START RECORDING ===
    btn.disabled = true;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) {
        statusText.textContent = 'No active tab found. Click on a tab and try again.';
        btn.disabled = false;
        return;
      }

      if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
        statusText.textContent = 'Cannot record Chrome system pages. Switch to a regular webpage.';
        btn.disabled = false;
        return;
      }

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

      chrome.runtime.sendMessage({
        type: 'start-recording',
        streamId,
        tabId: tab.id,
        tabTitle: tab.title || tab.url,
      }, (resp) => {
        btn.disabled = false;
        if (chrome.runtime.lastError) {
          statusText.textContent = 'Error: ' + chrome.runtime.lastError.message;
          return;
        }
        if (resp && resp.success) {
          setUI(true, tab.title || tab.url);
          startTimer();
          saveBtn.classList.remove('visible');
        } else {
          statusText.textContent = resp?.error || 'Failed to start recording';
        }
      });

    } catch (err) {
      btn.disabled = false;
      if (err.message?.includes('permission') || err.message?.includes('denied')) {
        statusText.textContent = 'Permission denied. Please allow audio capture and try again.';
      } else {
        statusText.textContent = 'Error: ' + err.message;
      }
    }

  } else {
    // === STOP RECORDING ===
    const elapsed = Date.now() - startTime;
    if (elapsed >= CONFIRM_THRESHOLD_MS) {
      confirmText.textContent = `Stop recording? ${formatTime(elapsed)} captured.`;
      confirmOverlay.classList.add('visible');
    } else {
      doStop();
    }
  }
});

// ── Confirm stop dialog ────────────────────────────────────────────────

confirmStop.addEventListener('click', () => {
  confirmOverlay.classList.remove('visible');
  doStop();
});

confirmCancel.addEventListener('click', () => {
  confirmOverlay.classList.remove('visible');
});

// ── Retry save button ──────────────────────────────────────────────────

saveBtn.addEventListener('click', () => {
  saveBtn.classList.remove('visible');
  statusText.textContent = 'Opening save dialog…';
  chrome.runtime.sendMessage({ type: 'retry-save' }, (resp) => {
    if (chrome.runtime.lastError || !resp?.success) {
      statusText.textContent = 'No pending recording to save';
      setTimeout(() => { statusText.textContent = 'Ready to record'; }, 2500);
    }
  });
});

// ── Listen for status updates from background ───────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'recording-status') {
    if (message.recording && !isRecording) {
      setUI(true);
      chrome.runtime.sendMessage({ type: 'get-status' }, (resp) => {
        if (resp && resp.recording && resp.startTime) {
          if (resp.channels) channels = resp.channels;
          if (resp.tabTitle) {
            tabInfoEl.textContent = 'Recording: ' + resp.tabTitle;
            tabInfoEl.classList.add('visible');
          }
          startTime = resp.startTime;
          if (!timerInterval) {
            timerInterval = setInterval(() => {
              timerEl.textContent = formatTime(Date.now() - startTime);
              updateFileSize();
            }, 250);
          }
        }
      });
    } else if (!message.recording && isRecording) {
      setUI(false);
    }
  }

  if (message.type === 'save-dialog-opening') {
    statusText.textContent = 'Choose where to save your recording…';
  }

  if (message.type === 'download-complete') {
    statusText.textContent = 'WAV saved';
    saveBtn.classList.remove('visible');
    setTimeout(() => { statusText.textContent = 'Ready to record'; }, 2500);
  }

  if (message.type === 'download-cancelled') {
    statusText.textContent = 'Save cancelled — recording kept in memory';
    saveBtn.classList.add('visible');
  }

  if (message.type === 'recording-error') {
    setUI(false);
    statusText.textContent = message.error || 'Unknown error';
  }

  if (message.type === 'audio-level-update') {
    const pct = Math.min(100, Math.round(message.peak * 100));
    levelFill.style.width = pct + '%';
  }
});
