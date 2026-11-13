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
const mainView = document.getElementById('mainView');
const settingsView = document.getElementById('settingsView');
const settingsBtn = document.getElementById('settingsBtn');
const backBtn = document.getElementById('backBtn');
const saveAsToggle = document.getElementById('saveAsToggle');
const openFolderToggle = document.getElementById('openFolderToggle');
const subfolderInput = document.getElementById('subfolderInput');
const prefixInput = document.getElementById('prefixInput');
const openDownloadsSettingsBtn = document.getElementById('openDownloadsSettingsBtn');
const saveBehaviorSummary = document.getElementById('saveBehaviorSummary');
const sampleRateSelect = document.getElementById('sampleRateSelect');
const channelModeSelect = document.getElementById('channelModeSelect');
const trimSilenceToggle = document.getElementById('trimSilenceToggle');
const silenceThresholdDbInput = document.getElementById('silenceThresholdDbInput');
const fadeMsInput = document.getElementById('fadeMsInput');
const normalizeToggle = document.getElementById('normalizeToggle');
const normalizeTargetDbInput = document.getElementById('normalizeTargetDbInput');

let isRecording = false;
let timerInterval = null;
let startTime = 0;

const DEFAULT_SETTINGS = {
  saveAs: true,
  openFolderAfterSave: false,
  subfolder: '',
  filenamePrefix: 'tab-capture_',
  sampleRate: 44100,
  channelMode: 'stereo', // 'stereo' | 'mono'
  trimSilence: true,
  silenceThresholdDb: -55,
  fadeMs: 10,
  normalize: true,
  normalizeTargetDb: -1.0,
};

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

function showView(which) {
  if (which === 'settings') {
    mainView.classList.remove('active');
    settingsView.classList.add('active');
  } else {
    settingsView.classList.remove('active');
    mainView.classList.add('active');
  }
}

function sanitizeSubfolder(input) {
  let s = (input || '').trim();
  if (!s) return '';
  s = s.replace(/\\\\/g, '/');
  s = s.replace(/\\.+/g, '.'); // collapse repeated dots (defensive)
  s = s.replace(/^\\/+/, '');
  if (s.includes('..')) s = s.replace(/\\.\\./g, '');
  if (s && !s.endsWith('/')) s += '/';
  return s;
}

function clamp(num, min, max) {
  return Math.min(max, Math.max(min, num));
}

function parseNumberOr(input, fallback) {
  const s = String(input ?? '').trim();
  if (!s) return fallback;
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

function updateSaveBehaviorSummary() {
  const saveAs = !!saveAsToggle.checked;
  const subfolder = sanitizeSubfolder(subfolderInput.value);
  const targetPath = subfolder ? `Downloads/${subfolder}` : 'Downloads/';

  if (saveAs) {
    saveBehaviorSummary.textContent =
      `Will show a “Save As” dialog for each recording. If you don’t see a dialog, check Chrome → Downloads settings and make sure downloads prompts aren’t being suppressed. Target path when accepted: ${targetPath}`;
  } else {
    saveBehaviorSummary.textContent =
      `Will auto-save into your default Downloads location (${targetPath}). Note: Chrome’s own “Ask where to save each file” setting may still cause prompts even if this toggle is off.`;
  }
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const settings = { ...DEFAULT_SETTINGS, ...stored };
  saveAsToggle.checked = !!settings.saveAs;
  openFolderToggle.checked = !!settings.openFolderAfterSave;
  subfolderInput.value = settings.subfolder || '';
  prefixInput.value = settings.filenamePrefix || DEFAULT_SETTINGS.filenamePrefix;
  sampleRateSelect.value = String(settings.sampleRate || DEFAULT_SETTINGS.sampleRate);
  channelModeSelect.value = settings.channelMode || DEFAULT_SETTINGS.channelMode;
  trimSilenceToggle.checked = !!settings.trimSilence;
  silenceThresholdDbInput.value = String(settings.silenceThresholdDb ?? DEFAULT_SETTINGS.silenceThresholdDb);
  fadeMsInput.value = String(settings.fadeMs ?? DEFAULT_SETTINGS.fadeMs);
  normalizeToggle.checked = !!settings.normalize;
  normalizeTargetDbInput.value = String(settings.normalizeTargetDb ?? DEFAULT_SETTINGS.normalizeTargetDb);
  updateSaveBehaviorSummary();
  return settings;
}

async function saveSettings(partial) {
  await chrome.storage.local.set(partial);
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

// ── Settings UI ─────────────────────────────────────────────────────────

loadSettings().catch(() => {});

settingsBtn.addEventListener('click', async () => {
  await loadSettings().catch(() => {});
  showView('settings');
});

backBtn.addEventListener('click', () => {
  showView('main');
});

saveAsToggle.addEventListener('change', () => {
  saveSettings({ saveAs: saveAsToggle.checked }).catch(() => {});
  updateSaveBehaviorSummary();
});

openFolderToggle.addEventListener('change', () => {
  saveSettings({ openFolderAfterSave: openFolderToggle.checked }).catch(() => {});
});

subfolderInput.addEventListener('change', () => {
  const cleaned = sanitizeSubfolder(subfolderInput.value);
  subfolderInput.value = cleaned;
  saveSettings({ subfolder: cleaned }).catch(() => {});
  updateSaveBehaviorSummary();
});

subfolderInput.addEventListener('input', () => {
  updateSaveBehaviorSummary();
});

prefixInput.addEventListener('change', () => {
  const cleaned = (prefixInput.value || '').trim() || DEFAULT_SETTINGS.filenamePrefix;
  prefixInput.value = cleaned;
  saveSettings({ filenamePrefix: cleaned }).catch(() => {});
});

sampleRateSelect.addEventListener('change', () => {
  const sr = parseInt(sampleRateSelect.value, 10);
  const sampleRate = sr === 48000 ? 48000 : 44100;
  sampleRateSelect.value = String(sampleRate);
  saveSettings({ sampleRate }).catch(() => {});
});

channelModeSelect.addEventListener('change', () => {
  const mode = channelModeSelect.value === 'mono' ? 'mono' : 'stereo';
  channelModeSelect.value = mode;
  saveSettings({ channelMode: mode }).catch(() => {});
});

trimSilenceToggle.addEventListener('change', () => {
  saveSettings({ trimSilence: trimSilenceToggle.checked }).catch(() => {});
});

silenceThresholdDbInput.addEventListener('change', () => {
  const n = parseNumberOr(silenceThresholdDbInput.value, DEFAULT_SETTINGS.silenceThresholdDb);
  const val = clamp(n, -90, -10);
  silenceThresholdDbInput.value = String(val);
  saveSettings({ silenceThresholdDb: val }).catch(() => {});
});

fadeMsInput.addEventListener('change', () => {
  const n = parseNumberOr(fadeMsInput.value, DEFAULT_SETTINGS.fadeMs);
  const val = clamp(Math.round(n), 0, 200);
  fadeMsInput.value = String(val);
  saveSettings({ fadeMs: val }).catch(() => {});
});

normalizeToggle.addEventListener('change', () => {
  saveSettings({ normalize: normalizeToggle.checked }).catch(() => {});
});

normalizeTargetDbInput.addEventListener('change', () => {
  const n = parseNumberOr(normalizeTargetDbInput.value, DEFAULT_SETTINGS.normalizeTargetDb);
  const val = clamp(n, -24, -0.1);
  normalizeTargetDbInput.value = String(val);
  saveSettings({ normalizeTargetDb: val }).catch(() => {});
});

openDownloadsSettingsBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'open-downloads-settings' });
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
  if (message.type === 'download-error') {
    statusText.textContent = 'Save failed: ' + (message.error || 'Unknown');
    setTimeout(() => {
      statusText.textContent = 'Ready to record';
    }, 4000);
  }
  if (message.type === 'recording-error') {
    setUI(false);
    statusText.textContent = 'Error: ' + (message.error || 'Unknown');
  }
});
