const $ = (id) => document.getElementById(id);

const stamp = (ms) => new Date(ms).toISOString().slice(11, 23);

async function restore() {
  const { port = 7788, token = '', debugMode = false, notify = true, forceEnabled = false } =
    await chrome.storage.local.get(['port', 'token', 'debugMode', 'notify', 'forceEnabled']);
  $('port').value = port;
  $('token').value = token;
  $('debug').checked = !!debugMode;
  $('notify').checked = notify !== false; // default on
  $('force').checked = !!forceEnabled;
  if (debugMode || location.search.includes('debug=1')) $('logwrap').classList.add('show');
  refreshLog();
}

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    port: Number($('port').value) || 7788,
    token: $('token').value.trim(),
    debugMode: $('debug').checked,
    notify: $('notify').checked,
  });
  $('status').textContent = 'Saved.';
  try { await chrome.runtime.sendMessage({ kind: 'CONFIGURED' }); } catch (_) {}
});

$('debug').addEventListener('change', () => {
  $('logwrap').classList.toggle('show', $('debug').checked);
});

$('notify').addEventListener('change', async () => {
  await chrome.storage.local.set({ notify: $('notify').checked });
  if ($('notify').checked) {
    // Ask the worker for a visible confirmation (respecting the just-saved flag).
    chrome.runtime.sendMessage({ kind: 'CONFIGURED' }, () => void chrome.runtime.lastError);
    try {
      chrome.notifications.create(
        {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/48.png'),
          title: 'Meetily Auto-Record',
          message: 'Notifications enabled ✓',
          priority: 2,
        },
        () => void chrome.runtime.lastError,
      );
    } catch (_) {}
  }
});

// Force trigger: meeting-URL alone counts as in-call (DOM-free, audio-free).
// For when detection selectors rot or Meet changes its render split.
$('force').addEventListener('change', async () => {
  await chrome.storage.local.set({ forceEnabled: $('force').checked });
  $('status').innerHTML = $('force').checked
    ? '<span class="ok">Force trigger ON — recording starts when a meeting URL is open (no UI checks).</span>'
    : 'Force trigger off — normal detection.';
});

// Manual start/stop: records immediately regardless of detection state.
$('forceStart').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ kind: 'FORCE_START' });
  $('status').innerHTML = res?.ok && res.json?.ok
    ? '<span class="ok">✓ Recording started (manual)</span>'
    : `<span class="bad">✗ Start failed: ${res?.error || res?.json?.error || 'see app notification'}</span>`;
});
$('forceStop').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ kind: 'FORCE_STOP' });
  $('status').textContent = 'Stopped.';
});

$('test').addEventListener('click', async () => {
  const port = Number($('port').value) || 7788;
  const token = $('token').value.trim();
  const statusEl = $('status');
  statusEl.textContent = 'Testing…';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ping`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      statusEl.innerHTML = `<span class="ok">✓ Meetily reachable${json.recording ? ' — recording active' : ''}</span>`;
    } else if (res.status === 401) {
      statusEl.innerHTML = '<span class="bad">✗ Server up, but token rejected — paste the token from Meetily settings</span>';
    } else {
      statusEl.innerHTML = `<span class="bad">✗ Server responded ${res.status}</span>`;
    }
  } catch (e) {
    statusEl.innerHTML = '<span class="bad">✗ Cannot reach Meetily — is the app running?</span>';
  }
});

// ---- debug log viewer --------------------------------------------------------
let lastSnapshot = '';
function render(found) {
  const lines = [];
  for (const tab of found || []) {
    lines.push(`── tab ${tab.tabId} f${tab.frameId} · ${tab.url?.slice(0, 100) || '?'} ${tab.signals?.isTop !== undefined ? (tab.signals.isTop ? '(top)' : '(sub)') : ''}`);
    lines.push(...(tab.log || []).slice(-40));
    const s = tab.signals;
    if (s) lines.push(`   SIGNALS: pathOk=${s.pathOk} leave=${s.joined} media=${s.media} lobby=${s.lobby}`);
    const c = tab.census;
    if (c) {
      lines.push(`   CENSUS: buttons=${c.visibleButtons}/${c.buttons} videos=${JSON.stringify(c.videos)} iframes=${c.iframes?.length ?? 0}`);
      lines.push(`   labels: ${c.labels.slice(0, 12).join(' | ') || '(none)'}`);
      lines.push(`   data-attrs: ${c.dataAttrs.join(', ') || '(none)'}`);
      if (c.iframes.length) lines.push(`   iframe srcs: ${c.iframes.join(' ; ') || '(none)'}`);
    }
  }
  const text = lines.join('\n') || '(no meeting tabs open — open a Meet/Teams/Zoom page to see detection logs)';
  return text;
}
async function refreshLog() {
  try {
    const view = await chrome.runtime.sendMessage({ kind: 'GET_DEBUG_VIEW' });
    const found = await chrome.runtime.sendMessage({ kind: 'COLLECT_TAB_DEBUG' });
    const workerLines = (view?.workerLog || []).map((l) => '· ' + l);
    const tabsText = (view?.tabs || [])
      .map((t) => {
        const fr = (t.frames || []).map((f) => `f${f.frameId}:leave=${f.joined ? 1 : 0},media=${f.media ? 1 : 0},lobby=${f.lobby ? 1 : 0}`).join(' ');
        return `· [tab ${t.id}] inMeeting=${t.inMeeting} meetingUrl=${t.meetingUrl} platform=${t.platform} frames=[${fr || '—'}]`;
      })
      .join('\n') || '· (no tracked tabs)';
    const ping = view?.ping
      ? `· ping: ${view.ping.ok ? `up (recording=${view.ping.recording})` : `down status=${view.ping.status} ${view.ping.error || ''}`}`
      : '· ping: (not configured)';
    const forced = view?.forced ? '· FORCED RECORDING ACTIVE' : '';
    const text =
      `== worker ==\n${ping}\n${forced}\n${tabsText}\n${workerLines.join('\n')}\n\n== meeting tabs (per frame) ==\n${render(found)}`;
    if (text !== lastSnapshot) {
      $('log').textContent = text;
      lastSnapshot = text;
    }
  } catch (e) {
    $('log').textContent = 'log refresh failed: ' + e;
  }
}
$('copyLog').addEventListener('click', async () => {
  await refreshLog();
  try {
    await navigator.clipboard.writeText($('log').textContent);
    $('copyLog').textContent = 'Copied ✓';
    setTimeout(() => ($('copyLog').textContent = 'Copy debug log'), 1200);
  } catch (_) {}
});

// One-shot deep probe: force-refreshes the live view including the DOM census
// from every open meeting tab (buttons, labels, videos, iframes, data-attrs).
$('probe').addEventListener('click', async () => {
  $('logwrap').classList.add('show');
  $('probe').textContent = 'Probing…';
  try {
    const found = await chrome.runtime.sendMessage({ kind: 'COLLECT_TAB_DEBUG' });
    lastSnapshot = '';
    const view = await chrome.runtime.sendMessage({ kind: 'GET_DEBUG_VIEW' });
    const workerLines = (view?.workerLog || []).map((l) => '· ' + l);
    const text =
      `== worker ==\n${workerLines.join('\n')}\n\n== meeting tabs (fresh probe, per frame) ==\n${render(found)}`;
    $('log').textContent = text;
    lastSnapshot = text;
  } catch (e) {
    $('log').textContent = 'probe failed: ' + e;
  }
  $('probe').textContent = 'Probe meeting tab now';
});

restore();
setInterval(refreshLog, 3000);