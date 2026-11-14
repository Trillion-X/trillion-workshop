import assert from 'node:assert/strict';
import { buildPostModels, relativeTime, monogram, recordList } from '../feed-selectors.mjs';

const NOW = Date.parse('2026-08-05T12:00:00Z');
const posts = [
  { kind:'community-post', id:'welcome', title:'Welcome', body:'You are in.', author:'Find Your Calling', created_at:'2026-08-01' },
  { kind:'community-post', id:'this-week', title:'This week', body:'Focus on foundations.', author:'Find Your Calling', created_at:'2026-08-04' },
  { kind:'community-post', id:'m1', title:'', body:'my first win', author:'Renee', author_role:'member', member_ref:'member:renee', created_at:'2026-08-05' },
];

let m = buildPostModels(posts, NOW);
assert.equal(m.length, 3, 'parses all 3');
assert.equal(m[0].id, 'm1', 'newest first');
assert.equal(m[2].id, 'welcome', 'oldest last');
assert.equal(m.find(x=>x.id==='welcome').isOperator, true, 'no member_ref => operator');
assert.equal(m.find(x=>x.id==='m1').isOperator, false, 'author_role member => not operator');
assert.equal(buildPostModels({records:posts}, NOW).length, 3, 'records wrapper');
assert.equal(buildPostModels([{kind:'offer', id:'x'}, ...posts], NOW).length, 3, 'drops non community-post');
assert.equal(relativeTime('2026-08-05', NOW), 'today');
assert.equal(relativeTime('2026-08-04', NOW), 'yesterday');
assert.equal(relativeTime('2026-08-01', NOW), '4d ago');
assert.equal(monogram('Find Your Calling'), 'FY');
assert.equal(monogram('Renee'), 'RE');
assert.equal(buildPostModels(undefined, NOW).length, 0);
assert.equal(buildPostModels(null, NOW).length, 0);
assert.equal(recordList('nonsense').length, 0);
console.log('ALL FEED-SELECTOR TESTS PASSED (7 groups)');
