const $ = (id) => document.getElementById(id);

async function restore() {
  const { port = 7788, token = '', debugMode = false, notify = true } =
    await chrome.storage.local.get(['port', 'token', 'debugMode', 'notify']);
  $('port').value = port;
  $('token').value = token;
  $('debug').checked = !!debugMode;
  $('notify').checked = notify !== false; // default on
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
  const stamp = (ms) => new Date(ms).toISOString().slice(11, 23);
  for (const tab of found || []) {
    lines.push(`── tab ${tab.tabId} · ${tab.url?.slice(0, 100) || '?'} · state=${tab.state}`);
    lines.push(...(tab.log || []).slice(-60));
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
      .map((t) => `· [tab ${t.id}] inMeeting=${t.inMeeting} platform=${t.platform} beat=${t.lastBeat ? stamp(t.lastBeat) : '—'}`)
      .join('\n') || '· (no tracked tabs)';
    const ping = view?.ping
      ? `· ping: ${view.ping.ok ? `up (recording=${view.ping.recording})` : `down status=${view.ping.status} ${view.ping.error || ''}`}`
      : '· ping: (not configured)';
    const text =
      `== worker ==\n${ping}\n${tabsText}\n${workerLines.join('\n')}\n\n== meeting tabs ==\n${render(found)}`;
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

restore();
setInterval(refreshLog, 3000);