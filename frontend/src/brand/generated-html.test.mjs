// Run after `next build` (output: export). Missing output fails rather than skips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const out = resolve(dirname(fileURLToPath(import.meta.url)), '../../out');
function htmlFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(dir, entry.name);
    return entry.isDirectory() ? htmlFiles(path) : entry.name.endsWith('.html') ? [path] : [];
  });
}
test('static export emits the canonical title on every application page', () => {
  const files = htmlFiles(out);
  assert.ok(files.includes(resolve(out, 'index.html')), 'home page must be exported');
  for (const file of files) {
    const titles = [...readFileSync(file, 'utf8').matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)];
    // Next's built-in 404 adds its own error title alongside root metadata.
    // Preserve the framework error page; application routes must have one title.
    if (file === resolve(out, '404.html')) {
      assert.ok(titles.some(title => title[1] === 'Pund-IT Meeting Assistant'), file);
    } else {
      assert.equal(titles.length, 1, file);
      assert.equal(titles[0][1], 'Pund-IT Meeting Assistant', file);
    }
  }
});
