import test from 'node:test';
import assert from 'node:assert/strict';
// tools/write-public-share-files/test/shareable-copy-privacy.test.mjs (moved from Trillion's test/shareable-copy-privacy.test.mjs)
import { shareableCopy as copyBy } from '../read-data/shareable-copy.mjs';
import data from '../read-data/share-files.json' with { type: 'json' };
import fixture from './fixtures/share-from-private.json' with { type: 'json' };

// The caller hands in its own rule table, as Trillion's person-spaces does with its share_from_private.
const shareableCopy = (type, id, value, shape) => copyBy(type, id, value, shape, fixture);

test('match-only fields leave as marks, including a field also used as the copy title', () => {
  const seen = [];
  const copy = shareableCopy('pursuit', 'pursuit:private', {
    title: 'Secret launch', now: 'private stage', after: 'publish', why_it_matters: 'private reason',
  }, { leave_out: ['why_it_matters'], match_only: ['title', 'now'], match: (field, value) => {
    seen.push([field, value]);
    return { match: `marked-${field}` };
  } });
  assert.equal(copy.title, null);
  assert.deepEqual(copy.body, { title: { match: 'marked-title' }, now: { match: 'marked-now' }, after: 'publish' });
  assert.deepEqual(seen, [['title', 'Secret launch'], ['now', 'private stage']]);
  assert.doesNotMatch(JSON.stringify(copy), /Secret launch|private stage|private reason/);
  assert.throws(() => shareableCopy('pursuit', 'pursuit:private', { now: 'secret' }, { match_only: ['now'] }), /not set up/);
});

test('a shared contract omits private fields at every configured depth', () => {
  const copy = shareableCopy('sales-contract', 'contract:one', {
    name: 'Morgan agreement',
    private_notes: 'owner only',
    contract: {
      name: 'Morgan agreement',
      private_notes: 'do not share',
      parties: [{ role: 'buyer', name: 'Morgan', private_email: 'user-84ba9e1f@example.com' }],
      price_experiment: {
        assignment: { status: 'assigned', method: 'random', private_seed: 'secret' },
        private_notes: 'internal pricing',
      },
    },
  });

  assert.deepEqual(copy.body, {
    name: 'Morgan agreement',
    contract: {
      name: 'Morgan agreement',
      parties: [{ role: 'buyer', name: 'Morgan' }],
      price_experiment: { assignment: { status: 'assigned', method: 'random' } },
    },
  });
  assert.equal(JSON.stringify(copy.body).includes('private_'), false);
});

test('a shared builder contract includes agreed price and access while excluding internal fields', () => {
  const copy = shareableCopy('sales-contract', 'sales-contract:free', {
    name: 'Complimentary Trillion',
    contract: {
      name: 'Complimentary Trillion', total_amount: 0, currency: 'usd', private_notes: 'owner only',
      rules: [
        { type: 'Commitment', label: 'Included access', amount: 0, currency: 'usd', recurrence: 'one_time', metadata: { secret: 'not for recipient' } },
        { type: 'GrantAccess', label: 'Trillion X’er', resource: 'offer:trillion-member', private_notes: 'do not share' },
      ],
      agreement_terms: { contract: {
        name: 'Complimentary access', scope: ['Trillion X’er at no charge'],
        price: { status: 'agreed', amount_cents: 0, currency: 'usd', secret: 'do not share' },
        sharing: { status: 'agreed', people: [], records: [], secret: 'do not share' },
        private_notes: 'do not share',
      }, private_notes: 'do not share' },
    },
  });
  assert.deepEqual(copy.body.contract, {
    name: 'Complimentary Trillion', total_amount: 0, currency: 'usd',
    rules: [
      { type: 'Commitment', label: 'Included access', amount: 0, currency: 'usd', recurrence: 'one_time' },
      { type: 'GrantAccess', label: 'Trillion X’er', resource: 'offer:trillion-member' },
    ],
    agreement_terms: { contract: {
      name: 'Complimentary access', scope: ['Trillion X’er at no charge'],
      price: { status: 'agreed', amount_cents: 0, currency: 'usd' },
      sharing: { status: 'agreed', people: [], records: [] },
    } },
  });
  assert.doesNotMatch(JSON.stringify(copy.body), /secret|private_notes|metadata/);
});

test('the List rule this tool carries lets out only the fields, rows and files a list copy is made of', () => {
  const copy = copyBy('list', 'list:one', {
    label: 'One', about: 'About it', owner_notes: 'private',
    fields: [{ id: 'name', label: 'Name', kind: 'text', formula: 'private' }],
    rows: [{ id: 'r1', title: 'Row', values: { name: 'Row' }, private_ref: 'record:x:r1' }],
    files: [{ identity: `1f:${'a'.repeat(64)}`, media_type: 'image/png', name: '/a.png', origin: 'private-bucket' }],
  }, { leave_out: ['about'] });
  assert.deepEqual(copy.body, { label: 'One', fields: [{ id: 'name', label: 'Name', kind: 'text' }],
    rows: [{ id: 'r1', title: 'Row', values: { name: 'Row' } }], files: [{ identity: `1f:${'a'.repeat(64)}`, media_type: 'image/png', name: '/a.png' }] });
  assert.equal(copy.title, 'One');
  assert.throws(() => copyBy('pursuit', 'pursuit:x', {}), /cannot be shared/, 'a kind this tool carries no rule for never leaves');
  assert.deepEqual(Object.keys(data.share_from_private), ['list']);
});
