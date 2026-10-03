// Run with node --test frontend/src-tauri/tests/branding-invariants.test.cjs
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const base = 'e86df852510ab879e8507577a2477a06917f7dfa';
const read = p => fs.readFileSync(path.join(root,p),'utf8');
const old = p => execFileSync('git',['show',`${base}:${p}`],{cwd:root,encoding:'utf8'});
const brand = 'Pund-IT Meeting Assistant';
test('native display metadata changes without identity/security/updater changes',()=>{
 const p='frontend/src-tauri/tauri.conf.json'; const now=JSON.parse(read(p)), before=JSON.parse(old(p));
 assert.equal(now.productName,brand); assert.equal(now.app.windows[0].title,brand);
 before.productName=brand; before.app.windows[0].title=brand;
 before.bundle.windows.nsis={template:'config/installer-compat.nsi'};
 assert.deepEqual(now,before);
});
test('Rust changes are presentation-only; logger, paths, DB, models and settings remain byte-identical',()=>{
 const changed=execFileSync('git',['diff',base,'--name-only','--','frontend/src-tauri'],{cwd:root,encoding:'utf8'}).trim().split('\n');
 for(const p of changed.filter(p=>p.endsWith('.rs'))) assert.equal(read(p),old(p).replaceAll('Meetily',brand),p);
 for(const p of ['Cargo.toml','src/lib.rs','src/main.rs','src/notifications/settings.rs','src/audio/recording_preferences.rs','src/auto_record/mod.rs','src/summary/templates/loader.rs','tauri.windows.conf.json']) {
  const full='frontend/src-tauri/'+p; assert.equal(read(full),old(full),p);
 }
 assert.ok(!read('frontend/src-tauri/src/main.rs').includes('env_logger::'));
});
test('extension manifest changes only presentation fields',()=>{
 const now=JSON.parse(read('extension/manifest.json')), before=JSON.parse(old('extension/manifest.json'));
 assert.equal(now.name,brand+' Auto-Record'); assert.equal(now.action.default_title,brand+' Auto-Record');
 for(const o of [now,before]) {delete o.name; delete o.description; delete o.action.default_title;}
 assert.deepEqual(now,before);
});
test('extension code preserves all storage, alarms, message types, pairing and transport behavior',()=>{
 for(const f of ['background.js','content.js','options.js','options.html']) assert.equal(read('extension/'+f),old('extension/'+f).replaceAll('Meetily',brand),f);
 for(const n of [16,48,128]) {
  const buf=fs.readFileSync(path.join(root,`extension/icons/${n}.png`));
  assert.equal(buf.subarray(1,4).toString(),'PNG'); assert.equal(buf.readUInt32BE(16),n); assert.equal(buf.readUInt32BE(20),n);
 }
});
test('NSIS legacy registry and directory identity is explicit, display and executable remain distinct',()=>{
 const s=read('frontend/src-tauri/config/installer-compat.nsi');
 assert.ok(s.includes('!define LEGACYPRODUCTNAME "meetily"'));
 assert.ok(s.includes('Uninstall\\${LEGACYPRODUCTNAME}'));
 assert.ok(s.includes('!define MANUPRODUCTKEY "${MANUKEY}\\${LEGACYPRODUCTNAME}"'));
 assert.ok(s.includes('MULTIUSER_INSTALLMODE_INSTDIR "${LEGACYPRODUCTNAME}"'));
 for(const r of ['$PROGRAMFILES64','$PROGRAMFILES','$LOCALAPPDATA']) assert.ok(s.includes(r+'\\${LEGACYPRODUCTNAME}'));
 assert.ok(s.includes('"DisplayName" "${PRODUCTNAME}"'));
 assert.ok(s.includes('!define MAINBINARYNAME "{{main_binary_name}}"'));
 assert.ok(s.includes('!define BUNDLEID "{{bundle_id}}"'));
});
