// Versions of the same file in one folder: the names Sam's own downloads carry (copy numbers, version numbers,
// export times, backups) group into one family each, the latest is marked, and a folder listing marks them even
// when a family reaches across pages. Exact copies under other names are counted.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { namespaceStore } from '../../recently-deleted-and-storage/namespace-store.mjs';
import { familyOf, versionFamilies } from '../src/file-versions.mjs';

const at = day => Date.UTC(2026, 8, day, 12);
const identity = digit => `1f:${String(digit).repeat(64)}`;

test('the marks on the end of a name are taken off to find its family', () => {
  const family = name => { const found = familyOf(name); return `${found.stem}.${found.extension}`; };
  assert.equal(family('/c/Modular_Instruction_Blocks_v5_7.md'), 'Modular_Instruction_Blocks.md');
  assert.equal(family('/c/Modular_Instruction_Blocks (1).md'), 'Modular_Instruction_Blocks.md');
  assert.equal(family('/c/ChatGPT-Create Modular Content Blocks-20260926-1624.md'), 'ChatGPT-Create Modular Content Blocks.md');
  assert.equal(family('/c/README(20260905-215248).md'), 'README.md');
  assert.equal(family('/c/Trillion_Dollar_Systems_v1_1.pdf'), 'Trillion_Dollar_Systems.pdf');
  assert.equal(family('/c/Pursuit_Content_Steward_v4.backup-before-semantic-uri-reconciliation-20260901T142317Z.db'), 'Pursuit_Content_Steward.db');
  assert.equal(family('/c/Pursuit_Content_Steward.pre-reference-grounded-correction-20260831T1949.db'), 'Pursuit_Content_Steward.db');
  assert.equal(family('/c/notes copy 2.txt'), 'notes.txt');
  assert.equal(family('/t/pottery-knowledge.db.backup-before-revert-1785908841'), 'pottery-knowledge.db', 'a backup mark after the extension');
  assert.equal(family('/t/pottery-knowledge.db.bak-localfiles'), 'pottery-knowledge.db');
  assert.equal(family('/c/New_10_Recording_Cards.md'), 'New_10_Recording_Cards.md', 'a number that is not a version mark stays');
  assert.equal(family('/c/v2.md'), 'v2.md', 'a name that is only a mark keeps its name');
  assert.equal(family('/c/(1).txt'), '(1).txt');
});

test('the latest version is the newest one, a backup is never the latest, and a lone file is no family', () => {
  const versions = versionFamilies([
    { name: '/c/Modular_Instruction_Blocks.md', modified_at_ms: at(5) },
    { name: '/c/Modular_Instruction_Blocks (1).md', modified_at_ms: at(6) },
    { name: '/c/Modular_Instruction_Blocks_v5_7.md', modified_at_ms: at(7) },
    { name: '/c/Pursuit_Content_Steward_v4.db', modified_at_ms: at(1) },
    { name: '/c/Pursuit_Content_Steward_v4.backup-before-semantic-uri-reconciliation-20260901T142317Z.db', modified_at_ms: at(2) },
    { name: '/c/Pursuit_Content_Steward.pre-reference-grounded-correction-20260831T1949.db', modified_at_ms: at(3) },
    { name: '/c/Modular_Instruction_Blocks.pdf', modified_at_ms: at(9) },
    { name: '/c/report.md', modified_at_ms: null },
    { name: '/c/report (1).md', modified_at_ms: null },
  ]);
  assert.deepEqual(versions.get('/c/Modular_Instruction_Blocks_v5_7.md'), { family: 'Modular_Instruction_Blocks.md', latest: true, latest_name: '/c/Modular_Instruction_Blocks_v5_7.md', versions: 3 });
  assert.equal(versions.get('/c/Modular_Instruction_Blocks.md').latest, false);
  assert.equal(versions.get('/c/Modular_Instruction_Blocks (1).md').latest_name, '/c/Modular_Instruction_Blocks_v5_7.md');
  assert.equal(versions.get('/c/Pursuit_Content_Steward_v4.db').latest, true, 'the backups are newer on disk but are copies made before a change');
  assert.equal(versions.get('/c/Pursuit_Content_Steward_v4.db').versions, 3);
  assert.equal(versions.has('/c/Modular_Instruction_Blocks.pdf'), false, 'another extension is another file');
  assert.equal(versions.get('/c/report.md').latest, true, 'with no times, the plain name is the latest');
});

test('a higher version number is the latest even when an older version was saved later', () => {
  const versions = versionFamilies([
    { name: '/c/System_Failure_Review_v5_2.md', modified_at_ms: at(9) },
    { name: '/c/System_Failure_Review_v5_3.md', modified_at_ms: at(8) },
    { name: '/c/Cards_v5_9.html', modified_at_ms: at(9) },
    { name: '/c/Cards_v5_10.html', modified_at_ms: at(1) },
    { name: '/c/Cards.html', modified_at_ms: at(5) },
  ]);
  assert.equal(versions.get('/c/System_Failure_Review_v5_3.md').latest, true, 'v5_3 over v5_2 downloaded three minutes later');
  assert.equal(versions.get('/c/System_Failure_Review_v5_2.md').latest_name, '/c/System_Failure_Review_v5_3.md');
  assert.equal(versions.get('/c/Cards_v5_10.html').latest, false, 'a name with no number is not outranked, so the newest of the rest wins');
  assert.equal(versions.get('/c/Cards.html').latest, true);
  assert.equal(versions.get('/c/Cards_v5_9.html').latest, false, '5.9 is below 5.10, part by part');
  assert.deepEqual(familyOf('/c/Cards_v5_10.html').number, [5, 10]);
});

test('a folder listing marks versions across pages and counts exact copies kept under other names', () => {
  const store = namespaceStore(sqliteHost(':memory:').sql);
  store.putNames([
    { name: '/Blocks/Alpha.md', identity: identity(1), byte_length: 10, modified_at_ms: at(1) },
    { name: '/Blocks/Modular_Instruction_Blocks.md', identity: identity(2), byte_length: 10, modified_at_ms: at(5) },
    { name: '/Blocks/Modular_Instruction_Blocks_extra.md', identity: identity(3), byte_length: 10, modified_at_ms: at(5) },
    { name: '/Blocks/Modular_Instruction_Blocks_v5_7.md', identity: identity(4), byte_length: 10, modified_at_ms: at(7) },
    { name: '/Blocks/Zeta.md', identity: identity(1), byte_length: 10, modified_at_ms: at(1) },
    { name: '/Elsewhere/Alpha copy.md', identity: identity(1), byte_length: 10, modified_at_ms: at(1) },
  ]);
  const pages = [];
  for (let after = ''; ;) {
    const page = store.listNames('/Blocks', after, 2);
    pages.push(...page.names);
    if (!page.next_after) break;
    after = page.next_after;
  }
  const byName = Object.fromEntries(pages.map(row => [row.name, row]));
  assert.equal(byName['/Blocks/Modular_Instruction_Blocks.md'].version.latest, false, 'its newer version is on the next page');
  assert.equal(byName['/Blocks/Modular_Instruction_Blocks.md'].version.latest_name, '/Blocks/Modular_Instruction_Blocks_v5_7.md');
  assert.equal(byName['/Blocks/Modular_Instruction_Blocks_v5_7.md'].version.latest, true);
  assert.equal(byName['/Blocks/Modular_Instruction_Blocks_v5_7.md'].version.versions, 2);
  assert.equal(byName['/Blocks/Modular_Instruction_Blocks_extra.md'].version, undefined, 'a longer name is its own file');
  assert.equal(byName['/Blocks/Alpha.md'].also_named, 2, 'the same bytes are also /Blocks/Zeta.md and /Elsewhere/Alpha copy.md');
  assert.equal(byName['/Blocks/Modular_Instruction_Blocks_v5_7.md'].also_named, undefined);
  assert.deepEqual(byName['/Blocks/Alpha.md'].also_at, ['/Blocks/Zeta.md', '/Elsewhere/Alpha copy.md'], 'and names where they are');
  assert.equal(store.putNames([{ name: `/Recordings/${'\u0000'.repeat(40)}./x.mp4`, identity: null }]).named, 0, 'a name with control characters is never kept');
});
