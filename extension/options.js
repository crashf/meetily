const $ = (id) => document.getElementById(id);

async function restore() {
  const { port = 7788, token = '' } = await chrome.storage.local.get(['port', 'token']);
  $('port').value = port;
  $('token').value = token;
}

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    port: Number($('port').value) || 7788,
    token: $('token').value.trim(),
  });
  $('status').textContent = 'Saved.';
  try { await chrome.runtime.sendMessage({ kind: 'CONFIGURED' }); } catch (_) {}
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

restore();