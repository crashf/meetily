import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const src = resolve(frontend, 'src');
const read = p => readFileSync(resolve(frontend, p), 'utf8');
const allowed = new Map([
  ['contexts/OnboardingContext.tsx', ['/usr/local/var/meetily/meeting_minutes.db']],
  ['services/indexedDBService.ts', ['MeetilyRecoveryDB']],
  ['lib/analytics.ts', ['meetily_user_id']],
  ['components/MeetingDetails/MeetingDetailsSplitView.tsx', ['meetily.meetingDetails.transcriptPaneRatio']],
  ['components/AutoRecordSettings.tsx', ['com.meetily.ai']],
  ['components/About.tsx', ['Based on Meetily by Zackriya Solutions (MIT)']],
  ['components/AnalyticsConsentSwitch.tsx', ['https://github.com/Zackriya-Solutions/meetily/blob/main/PRIVACY_POLICY.md']],
  ['components/DatabaseImport/HomebrewDatabaseDetector.tsx', ['/var/meetily/', 'Legacy Meetily Data Detected', 'previous Meetily installation']],
  ['components/DatabaseImport/LegacyDatabaseImport.tsx', ['select the Meetily folder', 'previous Meetily installation', 'previous Meetily folder']],
]);
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(resolve(dir, e.name)) : [resolve(dir, e.name)]);
}
test('every legacy source reference is explicitly justified by compatibility or attribution', () => {
  for (const file of walk(src).filter(p => /\.tsx?$/.test(p))) {
    const name = relative(src, file).replaceAll('\\', '/');
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (/meetily|zackriya/i.test(line)) assert.ok((allowed.get(name) || []).some(value => line.includes(value)), `${name}: ${line}`);
    }
  }
});
test('metadata, onboarding and recovery messaging carry the canonical product name', () => {
  for (const name of ['app/metadata.ts', 'app/metadata.tsx', 'components/onboarding/steps/WelcomeStep.tsx', 'hooks/useRecordingStart.ts', 'components/Info.tsx', 'components/Logo.tsx']) {
    assert.ok(read(`src/${name}`).includes('Pund-IT Meeting Assistant'), name);
  }
});
test('original asset master and both native platform icon containers exist', () => {
  assert.ok(read('public/pundit-meeting-assistant.svg').includes('Pund-IT Meeting Assistant'));
  for (const name of ['icon.ico', 'app_icon.ico']) assert.equal(readFileSync(resolve(frontend, 'src-tauri/icons', name)).subarray(0, 4).toString('hex'), '00000100');
  for (const name of ['icon.icns', 'app_icon.icns']) assert.equal(readFileSync(resolve(frontend, 'src-tauri/icons', name)).subarray(0, 4).toString(), 'icns');
});
test('support is Pund-IT; upstream attribution remains explicit', () => {
  const about = read('src/components/About.tsx');
  assert.ok(about.includes('https://pund-it.ca'));
  assert.ok(about.includes('Based on Meetily by Zackriya Solutions (MIT)'));
  assert.ok(!about.includes('Coming soon:'));
  assert.ok(!about.includes('never leave your machine'));
});
test('metadata is exported by the server layout with a stable client boundary', () => {
  const layout = read('src/app/layout.tsx');
  const client = read('src/app/ClientLayout.tsx');
  assert.ok(!layout.includes("'use client'"));
  assert.match(layout, /export \{ metadata \} from '\.\/metadata'/);
  assert.match(layout, /<ClientLayout>\{children\}<\/ClientLayout>/);
  assert.ok(client.startsWith("'use client'"));
  assert.ok(!client.includes('<html'));
  assert.ok(!client.includes('<body'));
});
test('privacy copy qualifies external summaries and network downloads', () => {
  for (const file of walk(src).filter(p => /\.tsx?$/.test(p))) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /(?:your data|recordings?|transcripts?|meetings?)[^\n]*never leave(?:s)?|all on your device|remain completely private and local|works offline, no cloud required/i, relative(src, file));
  }
  const welcome = read('src/components/onboarding/steps/WelcomeStep.tsx');
  for (const text of ['Recording and transcription run on your device', 'Local models work offline after download', 'External summary providers receive transcript content', 'Model downloads and updates require network access', 'is off by default']) assert.ok(welcome.includes(text), text);
  assert.ok(read('src/components/AnalyticsConsentSwitch.tsx').includes('transcript content is sent to that provider'));
});

test('privacy link identifies the verified upstream document without inventing a fork policy', () => {
  const source = read('src/components/AnalyticsConsentSwitch.tsx');
  assert.ok(source.includes('https://github.com/Zackriya-Solutions/meetily/blob/main/PRIVACY_POLICY.md'));
  assert.ok(source.includes('not a Pund-IT policy'));
  assert.ok(source.includes('pseudonymous'));
});
