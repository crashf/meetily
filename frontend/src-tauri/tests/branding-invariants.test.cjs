// Run with node --test frontend/src-tauri/tests/branding-invariants.test.cjs
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const base = 'e86df852510ab879e8507577a2477a06917f7dfa';
const read = p => fs.readFileSync(path.join(root,p),'utf8').replaceAll('\r\n','\n');
const old = p => execFileSync('git',['show',`${base}:${p}`],{cwd:root,encoding:'utf8'}).replaceAll('\r\n','\n');
const brand = 'Pund-IT Meeting Assistant';
test('native display metadata changes without identity/security/updater changes',()=>{
 const p='frontend/src-tauri/tauri.conf.json'; const now=JSON.parse(read(p)), before=JSON.parse(old(p));
 assert.equal(now.productName,brand); assert.equal(now.app.windows[0].title,brand);
 before.productName=brand; before.app.windows[0].title=brand;
 before.bundle.windows.nsis={template:'config/installer-compat.nsi'};
 before.bundle.windows.wix={upgradeCode:'293c4b6a-4aa1-5ef8-9cfd-823fc6139987'};
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

// Independent fixed-source invariants: no network, schema package or generated installer needed.
const crypto = require('node:crypto');
const legacyUpgradeCode = '293c4b6a-4aa1-5ef8-9cfd-823fc6139987';
const installer = () => read('frontend/src-tauri/config/installer-compat.nsi');
const correctionBlock = (s, name) => {
 const re = new RegExp(`    ; PUN-827 BEGIN ${name}[^\\n]*\\n([\\s\\S]*?)    ; PUN-827 END ${name}\\n`);
 const matches = [...s.matchAll(new RegExp(re.source,'g'))];
 assert.equal(matches.length,1, name+' unique');
 return matches[0][1];
};
test('MSI UpgradeCode pins exact CLI 2.11.1 legacy UUIDv5 DNS identity',()=>{
 // crates/tauri-bundler/src/bundle/windows/msi/mod.rs at tauri-cli-v2.11.1:
 // Uuid::new_v5(&Uuid::NAMESPACE_DNS, format!("{}.exe.app.x64", product_name).as_bytes())
 const dns = Buffer.from('6ba7b8109dad11d180b400c04fd430c8','hex');
 const bytes = crypto.createHash('sha1').update(dns).update('meetily.exe.app.x64').digest().subarray(0,16);
 bytes[6]=(bytes[6]&15)|0x50; bytes[8]=(bytes[8]&63)|0x80;
 const h=bytes.toString('hex');
 const generated=`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
 assert.equal(generated,legacyUpgradeCode);
 assert.deepEqual(JSON.parse(read('frontend/src-tauri/tauri.conf.json')).bundle.windows.wix,{upgradeCode:generated});
});
test('legacy shortcuts use exactly the upstream target guard/unpin/delete for all three locations',()=>{
 const s=installer(); const block=correctionBlock(s,'legacy shortcut cleanup');
 let expected='';
 for(const location of ['$SMPROGRAMS\\$AppStartMenuFolder','$SMPROGRAMS','$DESKTOP']) {
  const link=location+'\\${LEGACYPRODUCTNAME}.lnk';
  expected+=`    !insertmacro IsShortcutTarget "${link}" "$INSTDIR\\\${MAINBINARYNAME}.exe"\n    Pop $0\n    \${If} $0 = 1\n      !insertmacro UnpinShortcut "${link}"\n      Delete "${link}"\n`;
  if(location.includes('$AppStartMenuFolder')) expected+='      RMDir "$SMPROGRAMS\\$AppStartMenuFolder"\n';
  expected+='    ${EndIf}\n';
 }
 assert.equal(block,expected);
 // Require the addition inside the original non-update shortcut guard, not after it.
 const shortcutSection=s.slice(s.indexOf('  ; Remove shortcuts if not updating'),s.indexOf('  ; Remove registry information for add/remove programs'));
 assert.ok(shortcutSection.startsWith('  ; Remove shortcuts if not updating\n  ${If} $UpdateMode <> 1\n'));
 assert.ok(shortcutSection.endsWith('    ; PUN-827 END legacy shortcut cleanup\n  ${EndIf}\n\n'));
 assert.equal((s.match(/Delete "[^"\n]*\$\{LEGACYPRODUCTNAME\}\.lnk"/g)||[]).length,3);
});
test('legacy Run cleanup is non-update, only exact quoted/unquoted installed binary; no prefix matching',()=>{
 const s=installer(); const block=correctionBlock(s,'legacy Run cleanup');
 assert.ok(s.includes('  ${If} $UpdateMode <> 1\n    DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "${PRODUCTNAME}"\n    ; PUN-827 BEGIN legacy Run cleanup'));
 assert.ok(s.includes('    ; PUN-827 END legacy Run cleanup\n  ${EndIf}'));
 assert.equal(block, "    ReadRegStr $R7 HKCU \"Software\\Microsoft\\Windows\\CurrentVersion\\Run\" \"${LEGACYPRODUCTNAME}\"\n    ${If} $R7 == \"$INSTDIR\\${MAINBINARYNAME}.exe\"\n    ${OrIf} $R7 == \"$\\\"$INSTDIR\\${MAINBINARYNAME}.exe$\\\"\"\n      DeleteRegValue HKCU \"Software\\Microsoft\\Windows\\CurrentVersion\\Run\" \"${LEGACYPRODUCTNAME}\"\n    ${EndIf}\n");
});
test('entire normalized installer is byte-identical to exact CLI 2.11.1 upstream',()=>{
 let s=installer();
 for(const name of ['legacy shortcut cleanup','legacy Run cleanup']) {
  correctionBlock(s,name);
  s=s.replace(new RegExp(`    ; PUN-827 BEGIN ${name}[^\\n]*\\n[\\s\\S]*?    ; PUN-827 END ${name}\\n`),'');
 }
 s=s.replace(/    ; PUN-827 BEGIN MSI display-name compatibility\n[\s\S]*?    ; PUN-827 END MSI display-name compatibility\n/, '    StrCmp "$R0$R1" "${LEGACYPRODUCTNAME}${MANUFACTURER}" 0 wix_loop\n');
 s=s.replace('; PUN-827: keep upgrade registry/directory identity independent of display branding.\n!define LEGACYPRODUCTNAME "meetily"\n','').replaceAll('${LEGACYPRODUCTNAME}','${PRODUCTNAME}');
 assert.equal(crypto.createHash('sha256').update(s).digest('hex'),'ee84148e405adc4d736a46456dd8345a644751bd1f28a335dd7fd833a32d7c3e');
});

test('MSI predecessor detection accepts both display names with exact publisher and existing msiexec guard',()=>{
 const block=correctionBlock(installer(),'MSI display-name compatibility');
 assert.equal(block, '    ${If} $R1 != "${MANUFACTURER}"\n      Goto wix_loop\n    ${EndIf}\n    ${If} $R0 != "${LEGACYPRODUCTNAME}"\n    ${AndIf} $R0 != "${PRODUCTNAME}"\n      Goto wix_loop\n    ${EndIf}\n');
 const accepts=(name,publisher)=>publisher==='Zackriya' && ['meetily','Pund-IT Meeting Assistant'].includes(name);
 assert.ok(accepts('meetily','Zackriya')); assert.ok(accepts('Pund-IT Meeting Assistant','Zackriya'));
 assert.ok(!accepts('Other','Zackriya')); assert.ok(!accepts('meetily','Other'));
 assert.ok(installer().includes('${StrLoc} $R0 $R1 "msiexec" ">"\n    StrCmp $R0 0 0 wix_loop_done'));
});
