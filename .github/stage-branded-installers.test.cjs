const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { stage } = require('./stage-branded-installers.cjs');
const meta = { sha: 'e86df852510ab879e8507577a2477a06917f7dfa', runId: '123', attempt: '2' };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-delivery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'bundle');
  fs.mkdirSync(path.join(bundle, 'nsis'), { recursive: true });
  return { bundle, output: path.join(root, 'delivery') };
}
test('unique branded copies preserve installer and signature bytes with provenance', t => {
  const { bundle, output } = fixture(t);
  fs.writeFileSync(path.join(bundle, 'nsis', 'meetily_x64-setup.exe'), 'setup-bytes');
  fs.writeFileSync(path.join(bundle, 'nsis', 'meetily_x64-setup.exe.sig'), 'signature');
  const files = stage(bundle, output, meta);
  assert.equal(files.length, 2);
  assert.match(files[0].filename, /^pund-it-meeting-assistant-.*-run123-attempt2-x64-nsis-/);
  for (const f of files) {
    const original = fs.readFileSync(path.join(bundle, f.original));
    assert.deepEqual(fs.readFileSync(path.join(output, f.filename)), original);
    assert.equal(f.sha256, crypto.createHash('sha256').update(original).digest('hex'));
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'delivery-manifest.json'))).sourceSha, meta.sha);
  assert.throws(() => stage(bundle, output, meta), /EEXIST/);
});
test('missing NSIS fails rather than delivering empty or MSI-only set', t => {
  const { bundle, output } = fixture(t);
  assert.throws(() => stage(bundle, output, meta), /NSIS/);
  assert.equal(fs.existsSync(path.join(output, 'delivery-manifest.json')), false);
});
test('invalid provenance fails before output creation', t => {
  const { bundle, output } = fixture(t);
  assert.throws(() => stage(bundle, output, { ...meta, sha: 'branch-name' }), /full commit SHA/);
  assert.equal(fs.existsSync(output), false);
});
