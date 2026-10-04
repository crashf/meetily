// Copy installers into a uniquely named delivery set; never modify bundled bytes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function stage(bundle, output, { sha, runId, attempt }) {
  if (!/^[a-f0-9]{40}$/.test(sha) || !/^\d+$/.test(runId) || !/^\d+$/.test(attempt)) {
    throw new Error('Expected full commit SHA, numeric run ID and attempt');
  }
  if (!fs.lstatSync(bundle).isDirectory()) throw new Error('Bundle must be a real directory');
  // Refuse reuse/overwrite, including an existing symlink.
  fs.mkdirSync(output, { recursive: false });
  const files = [];
  for (const [folder, ext] of [['nsis', '.exe'], ['msi', '.msi']]) {
    const dir = path.join(bundle, folder);
    if (!fs.existsSync(dir)) continue;
    if (!fs.lstatSync(dir).isDirectory()) throw new Error('Installer directory must be a real directory');
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith(ext)) continue;
      const original = path.join(dir, name);
      if (!fs.lstatSync(original).isFile()) throw new Error('Installer must be a regular file');
      const prefix = `pund-it-meeting-assistant-${sha}-run${runId}-attempt${attempt}-x64`;
      const destination = `${prefix}-${folder}-${name}`;
      const copy = (source, filename) => {
        if (!fs.lstatSync(source).isFile()) throw new Error("Delivery source must be a regular file");
        fs.copyFileSync(source, path.join(output, filename), fs.constants.COPYFILE_EXCL);
        const bytes = fs.readFileSync(path.join(output, filename));
        files.push({ original: path.relative(bundle, source).split(path.sep).join('/'), filename,
          size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
      };
      copy(original, destination);
      if (fs.existsSync(`${original}.sig`)) copy(`${original}.sig`, `${destination}.sig`);
    }
  }
  if (!files.some(f => f.original.startsWith('nsis/') && f.filename.endsWith('.exe'))) {
    throw new Error('Required NSIS setup installer missing');
  }
  fs.writeFileSync(path.join(output, 'delivery-manifest.json'), JSON.stringify({
    sourceSha: sha, runId, attempt, platform: 'windows-x64',
    signing: 'Not asserted; verify actual artifact signatures separately', files
  }, null, 2) + '\n', { flag: 'wx' });
  return files;
}
module.exports = { stage };
if (require.main === module) {
  stage(process.argv[2], process.argv[3], {
    sha: process.env.DELIVERY_SHA, runId: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT
  });
}
