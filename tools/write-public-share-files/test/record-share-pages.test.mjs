import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerRecordShare as answerNativeRecordShare } from '../src/record-share-pages.mjs';
import { PAGE_SECTIONS_CSS, sectionHtml } from '../parts/ui/show/server-rendered-page/page-sections-html.mjs';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { importSource } from './import-source-for-tests.mjs';
const schemeBundle = (await build({ entryPoints: [new URL('../parts/screen-look/read-data/look-scheme.ts', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'error' })).outputFiles[0].text;
const { screenLookScheme } = await importSource(schemeBundle);
import { PAGE_LOOK } from '../src/page-look.mjs';
import { RECORD_SHARE_LINK_INDEX, previewOf } from '../src/record-sharing.mjs';
import { shareableCopy } from '../src/person-spaces.mjs';
import { HOT_PREFIX_BYTES } from '../src/namespace-edge-cache.mjs';
import sharing from '../src/record-sharing.json' with { type: 'json' };

// These route tests use PersonStore-shaped doubles on the legacy PERSON
// binding. Production resolves public shares through RECORD_BOOK; adapt those
// fixtures to the current owner contract without bypassing Namespace reads.
const adaptTestShareOwner = (person, env) => {
  person.withSharedNamespace ??= async (input, use) => {
    if (input?.operation === 'add-files') return use({ env, target: input.target });
    return use({ env, namespace: person, access: input?.access });
  };
  person.readSharedTranscript ??= async ({ identity, item_index, file_identity } = {}) => {
    if (typeof person.namespaceResults !== 'function')
      throw new Error('The test fixture has no shared transcript reader.');
    const stream = await person.namespaceResults('readBody', identity, 'transcript', 'public-share',
      ...(item_index === undefined ? [] : [item_index]), ...(file_identity === undefined ? [] : [file_identity]));
    const answer = await new Response(stream).json();
    const value = answer?.results?.[0]?.value;
    return { text: typeof value?.text === 'string' ? value.text : '',
      segments: Array.isArray(value?.segments) ? value.segments : [] };
  };
  return person;
};
const answerRecordShare = (request, options) => answerNativeRecordShare(request, {
  ...options,
  shareOwnerFor: options?.shareOwnerFor ?? (async ({ index }) => {
    const binding = options?.env?.PERSON;
    if (!binding || typeof binding.get !== 'function' || typeof binding.idFromString !== 'function')
      throw new Error('The test fixture has no PersonStore owner binding.');
    return adaptTestShareOwner(await binding.get(binding.idFromString(index.person_ref)), options.env);
  }),
});

test('request cancellation settles a public single range waiting for its first storage bytes', async () => {
  const code = 'c'.repeat(32);
  const identity = `1f:${'c'.repeat(64)}`;
  let source, start, canceled;
  const started = new Promise(resolve => { start = resolve; });
  const body = new ReadableStream({ start(controller) { source = controller; }, cancel() { canceled = true; } });
  let grants = 0, reads = 0;
  const person = { async sharedFileForLink() {
    grants += 1;
    return { copy: { kind: 'file', body: { identity, preview_identity: identity } },
      row: { identity, origin: 'bucket', key: 'clip', byte_length: 32, media_type: 'video/mp4' },
      owner_user_id: 'owner', attached_origin_ids: ['bucket'], attached_origins: [] };
  } };
  const env = {
    APP_KV: { get: async () => ({ person_ref: 'owner' }) },
    PERSON: { idFromString: id => id, idFromName: name => name, get: () => person },
    NAMESPACE_ORIGINS: JSON.stringify([{ id: 'bucket', interface: 'object-bucket', binding: 'FILE_BUCKET' }]),
    FILE_BUCKET: { get: async () => { reads += 1; start(); return { body }; } },
  };
  const caller = new AbortController();
  const request = new Request(`https://app.gettrillion.ai/share/${code}/preview`,
    { signal: caller.signal, headers: { range: 'bytes=0-15' } });
  const pending = answerRecordShare(request, { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai' });
  let timeout;
  try {
    await Promise.race([started, pending.then(() => { throw new Error('The public fixture ended before storage opened'); })]);
    caller.abort(new DOMException('The recipient left', 'AbortError'));
    const response = await Promise.race([pending, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('The abandoned public first-byte wait remained pending')), 1000);
    })]);
    assert.equal(response.status, 503, 'the existing unavailable response remains');
    await response.body?.cancel();
    assert.ok(canceled, 'the actual storage body is canceled before any first byte exists');
    assert.equal(grants, 1, 'the route still performs its current grant read');
    assert.equal(reads, 1, 'cancellation starts no second origin read');
  } finally {
    clearTimeout(timeout);
    if (!canceled) source.error(new Error('Fixture cleanup'));
    await pending;
  }
});

test('public header and attribution use the exact site wordmark; link previews keep the app icon', () => {
  const mark = new URL(sharing.look.made_with.mark, 'https://app.gettrillion.ai');
  assert.equal(sharing.look.trillion.logo, sharing.look.made_with.mark, 'the public header and footer use one full wordmark');
  assert.equal(mark.pathname, '/brand/current/wordmark.svg');
});

test('generic card covers and numbered navigation escape copy and refuse unsafe addresses', () => {
  const html = sectionHtml({ cards: [{ heading: 'A <clip>', href: 'javascript:alert(1)', cover: {
    src: 'javascript:alert(2)', glyph: '▶', label: 'Video <script>',
  } }], pagination: { label: 'Shared pages', previous: { label: 'Previous' },
    pages: [{ number: 1, current: true }, { ellipsis: true }, { number: 3, href: '/share/example?offset=24' }],
    next: { label: 'Next', href: '/share/example?offset=12' } } });
  assert.match(html, /A &lt;clip&gt;/);
  assert.match(html, /Video &lt;script&gt;/);
  assert.doesNotMatch(html, /javascript:|<script>/);
  assert.match(html, /aria-label="Shared pages"/);
  assert.match(html, /aria-current="page"/);
  assert.match(html, /aria-disabled="true"/);
  assert.match(html, /href="\/share\/example\?offset=24"/);
  const words = sectionHtml({ cards: [{ heading: 'A note', cover: { label: 'Note', glyph: '¶', text: 'A real <thought> & the rest.' } }] });
  assert.match(words, /page-card-cover-text">A real &lt;thought&gt; &amp; the rest\.<\/p>/);
  assert.doesNotMatch(words, /page-card-cover-glyph|<thought>/, 'words replace the generic glyph and remain inert text');
});

// Test doubles execute the PersonStore's new single-turn file lookup locally.
const withShareFileAccess = person => {
  person.sharedFileForLink ??= async (code, recipient, part) => {
    const copy = await person.resolveRecordShare(code, { ...recipient, record_view: false });
    const identity = part === 'preview' ? copy?.body?.preview_identity
      : part === 'poster' ? copy?.body?.poster_identity : copy?.body?.identity;
    const row = copy?.kind === 'file' && typeof identity === 'string' ? await person.namespaceLocate?.(identity) : null;
    return { copy, row, owner_user_id: row ? (await person.ownerUserId?.()) ?? null : null };
  };
  // A view-only link the grant admits; a refused grant still ends the page when the copy is read.
  person.shareAccess ??= async () => {
    return { admitted: true, needs: null, closed: false, can: ['view'], acts_need_proof: false, proven: false, sender: 'Ana', look: { kind: 'trillion', name: 'Trillion' }, signatures: [], signed_by_you: false, paid: false, delivers_on_sign: false };
  };
  person.sharedPageForLink ??= async (code, recipient, { count_open, item_offset, item_limit } = {}) => {
    const access = await person.shareAccess(code, recipient);
    return { access, copy: access.admitted
      ? await person.resolveRecordShare(code, { ...recipient, record_view: false, count_open, item_offset, item_limit }) : null };
  };
  return person;
};

test('a share wears its sharer\'s worn look, the same look their workspace wears, never the operator\'s', async () => {
  const code = 'k'.repeat(32);
  const { lookFor } = await import('../src/page-look.mjs');
  const { default: looks } = await import('../src/workspace/looks.json', { with: { type: 'json' } });
  const worn = { worn: 'trillion-black', plan: null, looks: looks.themes.map(row => row.payload) };
  const person = {
    async sharedPageForLink() {
      return { access: { admitted: true, needs: null, closed: false, can: ['view'], acts_need_proof: false,
        proven: false, sender: 'Ana', look: { kind: 'trillion', name: 'Trillion', worn },
        signatures: [], signed_by_you: false, paid: false },
      copy: { kind: 'text', title: 'A note', body: { text: 'Hello' } } };
    },
  };
  const env = { APP_KV: { get: async () => ({ person_ref: 'owner' }) }, PERSON: { idFromString: id => id, get: () => person } };
  const response = await answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}`), { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai' });
  const html = await response.text();
  const black = lookFor('trillion-black').palette;
  for (const name of ['--bg-primary', '--text-primary', '--button-primary-bg', '--font-primary', '--font-display', '--radius-control']) {
    assert.ok(html.includes(`${name}:${black[name]}`), `${name} is the sharer's worn look`);
  }
  assert.match(html, /wordmark\.svg\?tone=dark/, 'the mark is drawn for the dark ground');
  assert.doesNotMatch(html, /look\.css/);
});

test('a public share uses the workspace Screen Look while preserving the sender accent', async () => {
  const code = 'l'.repeat(32);
  const person = {
    async sharedPageForLink() {
      return { access: { admitted: true, needs: null, closed: false, can: ['view'], acts_need_proof: false,
        proven: false, sender: 'Ana', look: { kind: 'own', name: 'Ana Studio', accent: '#368a56' },
        signatures: [], signed_by_you: false, paid: false },
      copy: { kind: 'text', title: 'A note', body: { text: 'Hello' } } };
    },
  };
  const env = { APP_KV: { get: async () => ({ person_ref: 'owner' }) }, PERSON: { idFromString: id => id, get: () => person } };
  const response = await answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}`), { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai' });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /data-theme="paper"/);
  assert.match(html, /class="page-layout page-layout--share"/);
  assert.ok(html.includes(`--bg-primary:${PAGE_LOOK.palette['--bg-primary']}`));
  assert.ok(html.includes(`--font-primary:${PAGE_LOOK.palette['--font-primary']}`));
  assert.ok(html.includes(`--font-display:${PAGE_LOOK.palette['--font-display']}`));
  assert.match(html, /--button-primary-bg:#368a56/);
  assert.match(html, /--button-primary-bg-hover:#368a56/);
  assert.match(html, /page-section--share-brand"><p class="page-body">Ana Studio<\/p><\/section>/, 'a sender without a logo keeps their own name');
  assert.match(html, /Made with/);
  assert.doesNotMatch(html, /<p class="page-eyebrow">/);
});

test('public record share page rechecks the current grant on every request', async () => {
  const code = 'a'.repeat(32);
  const values = new Map([[`${RECORD_SHARE_LINK_INDEX}${code}`, JSON.stringify({ person_ref: 'owner' })]]);
  let open = true;
  const views = [];
  const person = {
    resolveRecordShare: async (_code, recipient) => {
      views.push(recipient.record_view);
      if (!open) throw new Error('This share link has ended.');
      return { kind: 'file', title: 'Morgan recording', body: { identity: '1f:abc', byte_length: 12, media_type: 'video/mp4' } };
    },
  };
  const env = { APP_KV: { get: async (key, type) => { const value = values.get(key); return value === undefined ? null : type === 'json' ? JSON.parse(value) : value; } }, PERSON: { idFromString: id => id, get: () => withShareFileAccess(person) } };
  const request = () => new Request(`https://app.gettrillion.ai/share/${code}`);
  const before = await answerRecordShare(request(), { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai' });
  assert.equal(before.status, 200);
  assert.equal(before.headers.get('referrer-policy'), 'no-referrer', 'opening an outside link must not disclose the share code');
  assert.deepEqual(views, [false], 'opening a public page reads the grant without writing into its owner account');
  const html = await before.text();
  assert.match(html, /page-section--share-brand"><img class="page-mark" src="\/brand\/current\/wordmark\.svg\?tone=light" alt="Trillion"/, 'the mark is drawn for the light ground the page wears');
  assert.doesNotMatch(html, /\/brand\/current\/look\.css/, 'a share never wears the service operator\'s look');
  const brandHtml = html.match(/<section class="page-section page-section--share-brand">[\s\S]*?<\/section>/)?.[0];
  assert.ok(brandHtml);
  assert.doesNotMatch(brandHtml, /<p class="page-body">Trillion<\/p>/, 'the full logo does not repeat its name beside it');
  assert.match(html, /<span class="page-action-label">Made with<\/span><span class="page-action-mark-wrap"><img class="page-action-mark" src="\/brand\/current\/wordmark\.svg\?tone=light"/);
  assert.match(html, /<meta property="og:image" content="https:\/\/app\.gettrillion\.ai\/icon-512\.png"\/>/);
  assert.match(html, /<meta name="twitter:image" content="https:\/\/app\.gettrillion\.ai\/icon-512\.png"\/>/);
  assert.match(html, /<meta name="twitter:card" content="summary"\/>/);
  assert.match(html, /page-action-mark"[^>]+loading="eager" fetchpriority="high"/);
  assert.match(html, /page-action-mark-wrap[\s\S]*class="loading-mark"[^>]+aria-hidden="true"/);
  assert.match(html, /alt="Trillion"/);
  assert.match(html, /share-view\.js/);
  assert.match(html, /data-media-playback-url=/);
  assert.doesNotMatch(html, /<video[^>]+controls/);
  assert.doesNotMatch(html, /video\/mp4\s*·|12 bytes/);
  open = false;
  const after = await answerRecordShare(request(), { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai' });
  assert.equal(after.status, 404);
  assert.equal(after.headers.get('referrer-policy'), 'no-referrer');
  const endedHtml = await after.text();
  assert.match(endedHtml, /page-layout--share/);
  assert.match(endedHtml, /page-section--share-footer[\s\S]*\/brand\/current\/wordmark\.svg/);
  assert.doesNotMatch(endedHtml, /class="page-eyebrow/);
});

test('a fully discounted Checkout says nothing was due today', async () => {
  const code = 'z'.repeat(32);
  const person = {
    async shareAccess() { return { admitted: true, needs: null, closed: false, can: ['view', 'pay'], acts_need_proof: false, proven: true,
      sender: 'Ana', look: { kind: 'trillion', name: 'Trillion' }, signatures: [], signed_by_you: false, paid: true }; },
    async resolveRecordShare() { return { kind: 'sales-contract', title: 'One session', body: { name: 'One session' } }; },
    async sharePaymentTerms() { return { status: 'paid', terms: { label: 'One session', amount_cents: 50, currency: 'usd', payment_timing: 'one_time',
      included: [{ label: 'One session' }] }, amount_due_today_cents: 0 }; },
  };
  const env = { APP_KV: { get: async () => ({ person_ref: 'owner' }) }, PERSON: { idFromString: id => id, get: () => withShareFileAccess(person) } };
  const page = await answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}`), { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai' });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Order complete\. Nothing due today\./);
  assert.match(html, /Included with this order/);
  assert.doesNotMatch(html, /Paid\. Thank you\. \$0\.50 one time/);
});

test('a payable contract shows its negotiated price without raw cents or internal rule fields', async () => {
  const code = 'p'.repeat(32);
  const copy = { kind: 'sales-contract', title: 'Three coaching payments', body: {
    name: 'Three coaching payments', contract: { name: 'Three coaching payments', total_amount: 450000,
      rules: [{ type: 'Commitment', amount: 150000, total_amount: 450000, currency: 'usd', recurrence: 'monthly', metadata: { billing_cycles: 3 } }] },
  } };
  assert.equal(previewOf(copy).fields.find(field => field.id === 'contract.total_amount').value, '$4,500.00');
  const person = withShareFileAccess({
    async shareAccess() { return { admitted: true, needs: null, closed: false, can: ['view', 'pay'], acts_need_proof: true,
      proven: false, sender: 'Ana', look: { kind: 'trillion', name: 'Trillion' }, signatures: [], signed_by_you: false, paid: false }; },
    async resolveRecordShare() { return { ...copy, preview: previewOf(copy) }; },
    async sharePaymentTerms() { return { status: 'offered', terms: { label: 'Three coaching payments', amount_cents: 150000,
      total_contract_amount_cents: 450000, billing_cycles: 3, currency: 'usd', payment_timing: 'subscription', interval: 'month' } }; },
  });
  const env = { APP_KV: { get: async () => ({ person_ref: 'owner' }) }, PERSON: { idFromString: id => id, get: () => person } };
  const response = await answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}`), { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai' });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /\$1,500\.00 every month for 3 payments/);
  assert.match(html, /Agreement total/);
  assert.match(html, /\$4,500\.00/);
  assert.doesNotMatch(html, /450000|150000|Payment and access terms|Type: Commitment/);
});

test('a refunded contract no longer says the order is paid', async () => {
  const code = 'r'.repeat(32);
  const person = {
    async shareAccess() { return { admitted: true, needs: null, closed: false, can: ['view', 'pay'], acts_need_proof: false, proven: true,
      sender: 'Ana', look: { kind: 'trillion', name: 'Trillion' }, signatures: [], signed_by_you: false, paid: true }; },
    async resolveRecordShare() { return { kind: 'sales-contract', title: 'One session', body: { name: 'One session' } }; },
    async sharePaymentTerms() { return { status: 'payment-ended', payment_end_reason: 'refunded',
      terms: { label: 'One session', amount_cents: 50, currency: 'usd', payment_timing: 'one_time' } }; },
  };
  const env = { APP_KV: { get: async () => ({ person_ref: 'owner' }) }, PERSON: { idFromString: id => id, get: () => withShareFileAccess(person) } };
  const response = await answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}`), { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai' });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /This order was refunded/);
  assert.doesNotMatch(html, /Paid\. Thank you/);
});

test('a public page asks its owner once for access and the current copy', async () => {
  const code = 'q'.repeat(32);
  let calls = 0;
  let open = true;
  const person = {
    async sharedPageForLink(_code, recipient, { count_open, caller_started_at: callerStartedAt }) {
      await new Promise(resolve => setTimeout(resolve, 20));
      calls += 1;
      assert.equal(recipient.link_index.person_ref, 'owner');
      assert.equal(count_open, true);
      assert.ok(Number.isFinite(callerStartedAt));
      return { access: { admitted: open, needs: null, closed: !open, can: ['view'], acts_need_proof: false,
        proven: false, sender: 'Ana', look: { kind: 'trillion', name: 'Trillion' }, signatures: [], signed_by_you: false,
        paid: false, delivers_on_sign: false },
      copy: open ? { kind: 'text', title: 'Shared words', body: { text: 'Hello' } } : null,
      _timing: { admission_ms: 0.01, admission_state: open ? 'measured' : 'measured", private;desc="secret',
        owner_version: open ? '11111111-2222-3333-4444-555555555555' : 'not-a-version;desc="secret',
        initial_admission_ms: 1234, constructor_ms: 2345, grant_ms: 1, sender_ms: 2, owner_arrival_ms: 4, owner_method_ms: 7,
        ...(open ? { copy_ms: 3 } : {}) } };
    },
    shareAccess() { throw new Error('The route made a second owner request for access.'); },
    resolveRecordShare() { throw new Error('The route made a second owner request for the copy.'); },
  };
  const env = { APP_KV: { get: async () => ({ person_ref: 'owner' }) }, PERSON: { idFromString: id => id, get: () => person } };
  const request = () => new Request(`https://app.gettrillion.ai/share/${code}`);
  const first = await answerRecordShare(request(), { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai' });
  assert.equal(first.status, 200);
  assert.match(first.headers.get('server-timing'), /access_admission;dur=/);
  assert.match(first.headers.get('server-timing'), /access_admission_state;desc="measured"/);
  assert.match(first.headers.get('server-timing'), /owner_version;desc="11111111-2222-3333-4444-555555555555"/);
  assert.match(first.headers.get('server-timing'), /owner_initial_admission;dur=1234\.0/);
  assert.match(first.headers.get('server-timing'), /owner_constructor;dur=2345\.0/);
  assert.doesNotMatch(first.headers.get('server-timing'), /access_constructor/);
  const pageTimes = new Map([...first.headers.get('server-timing').matchAll(/(\w+);dur=([\d.]+)/g)].map(([, key, value]) => [key, Number(value)]));
  assert.ok(pageTimes.get('access_wait') > 5, 'historical work does not erase the current wait');
  assert.ok(Math.abs(pageTimes.get('access') - ['access_admission', 'access_grant', 'access_sender', 'access_copy', 'access_wait'].reduce((sum, key) => sum + (pageTimes.get(key) ?? 0), 0)) < 0.3);
  assert.match(first.headers.get('server-timing'), /access_grant;dur=\d+\.\d/);
  assert.match(first.headers.get('server-timing'), /access_sender;dur=\d+\.\d/);
  assert.match(first.headers.get('server-timing'), /access_copy;dur=\d+\.\d/);
  assert.match(first.headers.get('server-timing'), /access_wait;dur=/);
  assert.match(first.headers.get('server-timing'), /owner_arrival;dur=/);
  assert.match(first.headers.get('server-timing'), /owner_method;dur=/);
  assert.equal(calls, 1);
  open = false;
  const ended = await answerRecordShare(request(), { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai' });
  assert.equal(ended.status, 403);
  assert.doesNotMatch(ended.headers.get('server-timing'), /access_admission_state|owner_version|private|secret/,
    'unrecognized clock states and code versions cannot become HTTP diagnostics');
  assert.match(ended.headers.get('server-timing'), /access_grant;dur=\d+\.\d/);
  assert.equal(calls, 2, 'a second page request asks the owner again, rather than reusing an earlier admission');
});

test('a deferred public sender does not add an eyebrow or an extra first-paint request', async () => {
  const code = 's'.repeat(32);
  let name = 'Ana';
  let open = true;
  const person = {
    async sharedPageForLink() {
      if (!open) throw new Error('This share link has ended.');
      return { access: { admitted: true, deferred_sender: true, needs: null, closed: false, can: ['view'],
        acts_need_proof: false, proven: false, sender: null, look: { kind: 'trillion', name: 'Trillion' },
        signatures: [], signed_by_you: false, paid: false },
      copy: { kind: 'text', title: 'Shared words', body: { text: 'Hello' } }, _timing: { grant_ms: 1, copy_ms: 2 } };
    },
    async shareSenderForLink() {
      if (!open) throw new Error('This share link has ended.');
      return name;
    },
  };
  const env = { APP_KV: { get: async () => ({ person_ref: 'owner' }) }, PERSON: { idFromString: id => id, get: () => person } };
  const origin = 'https://app.gettrillion.ai';
  const read = part => answerRecordShare(new Request(`${origin}/share/${code}${part}`), { env, kv: env.APP_KV, origin });
  const page = await read('');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<h1 class="page-heading">Shared words<\/h1>/);
  assert.match(html, /page-section--share-brand"><img class="page-mark" src="\/brand\/current\/wordmark\.svg/);
  assert.doesNotMatch(html, /Shared with you|<p class="page-eyebrow">|share-sender\.js/);
  assert.doesNotMatch(page.headers.get('server-timing'), /access_sender;/);
  assert.deepEqual(await (await read('/_sender')).json(), { sender: 'Ana' });
  name = 'Anastasia';
  assert.deepEqual(await (await read('/_sender')).json(), { sender: 'Anastasia' });
  name = null;
  assert.deepEqual(await (await read('/_sender')).json(), { sender: null });
  open = false;
  assert.equal((await read('/_sender')).status, 404);
});

test('a temporary owner failure does not falsely say a public share was ended', async () => {
  const code = 'z'.repeat(32);
  const person = { resolveRecordShare: async () => { throw new Error('Exceeded the maximum database size.'); } };
  const env = { APP_KV: { get: async () => ({ person_ref: 'owner' }) }, PERSON: { idFromString: id => id, get: () => withShareFileAccess(person) } };
  const response = await answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}`), { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai' });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '10');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const html = await response.text();
  assert.match(html, /This share is temporarily unavailable/);
  assert.match(html, /data-theme="paper"/, 'a retryable share keeps the workspace look instead of the ink override');
  assert.ok(html.includes(`--bg-primary:${PAGE_LOOK.palette['--bg-primary']}`));
  assert.match(html, /page-layout--share/, 'a retryable share keeps the recipient page layout');
  assert.match(html, /\/workspace\/public-share\.css/, 'a retryable share uses the public share Screen Look');
  assert.match(html, /--font-display:Recoleta/, 'its display face comes from the workspace look');
  assert.match(html, /page-section--share-footer[\s\S]*\/brand\/current\/wordmark\.svg/, 'its footer uses the supplied Trillion wordmark');
  assert.doesNotMatch(html, /class="page-eyebrow/, 'the failure page never adds an eyebrow');
  assert.doesNotMatch(html, /This share link has ended|Exceeded the maximum database size|z{32}/);
  const file = await answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}/file`, {
    headers: { origin: 'https://example.org', range: 'bytes=0-15' },
  }), { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai' });
  assert.equal(file.status, 503);
  assert.equal(file.headers.get('access-control-allow-origin'), '*', 'an embedding site can see the retryable failure');
  assert.equal(file.headers.get('retry-after'), '10');
  assert.match(file.headers.get('access-control-expose-headers') ?? '', /retry-after/);
  assert.doesNotMatch(await file.text(), /Exceeded the maximum database size|z{32}/);
  const data = await answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}.json`, {
    headers: { origin: 'https://example.org' },
  }), { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai' });
  assert.equal(data.status, 503);
  assert.equal(data.headers.get('access-control-allow-origin'), '*');
  assert.equal(data.headers.get('retry-after'), '10');
  assert.match(data.headers.get('access-control-expose-headers') ?? '', /retry-after/);
  assert.deepEqual(await data.json(), { error: 'This share is temporarily unavailable.' });
});

test('a temporary owner failure logs a fixed reason without private file words', async () => {
  const code = 'q'.repeat(32);
  const privateWords = 'private-client-film.mp4';
  const person = { sharedPageForLink: async () => {
    const error = new Error(`RPC timed out while reading ${privateWords}`);
    error.name = privateWords;
    throw error;
  } };
  const env = { APP_KV: { get: async () => ({ person_ref: 'owner' }) }, PERSON: { idFromString: id => id, get: () => person } };
  const logged = [];
  const original = console.error;
  console.error = (...args) => { logged.push(args); };
  try {
    const response = await answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}.json`), { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai' });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'This share is temporarily unavailable.' });
  } finally {
    console.error = original;
  }
  const said = JSON.stringify(logged);
  assert.match(said, /"reason":"timeout"/);
  assert.doesNotMatch(said, /private-client-film|q{32}/);
});

test('a temporary link-index failure keeps the share retryable', async () => {
  const code = 'u'.repeat(32);
  const kv = { get: async () => { throw new Error('KV read temporarily failed'); } };
  const response = await answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}`), {
    env: { APP_KV: kv }, kv, origin: 'https://app.gettrillion.ai',
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '10');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const html = await response.text();
  assert.match(html, /This share is temporarily unavailable/);
  assert.match(html, /page-layout--share/);
  assert.match(html, /page-section--share-footer[\s\S]*\/brand\/current\/wordmark\.svg/);
  assert.doesNotMatch(html, /This share link has ended|KV read temporarily failed|u{32}/);
  const data = await answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}.json`, {
    method: 'HEAD', headers: { origin: 'https://example.org' },
  }), { env: { APP_KV: kv }, kv, origin: 'https://app.gettrillion.ai' });
  assert.equal(data.status, 503);
  assert.equal(data.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(data.headers.get('access-control-allow-origin'), '*');
  assert.equal(data.headers.get('retry-after'), '10');
  assert.equal(await data.text(), '');
  const missing = await answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}.json`, {
    headers: { origin: 'https://example.org' },
  }), { env: { APP_KV: { get: async () => null } }, kv: { get: async () => null }, origin: 'https://app.gettrillion.ai' });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await missing.json(), { error: 'This share is not available.' });
});

test('a canceled client leaves a stage-only clue while a share lookup remains pending', async () => {
  const code = 'w'.repeat(32);
  const controller = new AbortController();
  let release;
  const kv = { get: () => new Promise(resolve => { release = resolve; }) };
  const events = [];
  const originalWarn = console.warn;
  console.warn = (message, details) => {
    if (typeof message === 'string' && message.startsWith('public share stage')) events.push({ message, details });
    else originalWarn(message, details);
  };
  try {
    const pending = answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}`, { signal: controller.signal }), {
      env: { APP_KV: kv }, kv, origin: 'https://app.gettrillion.ai',
    });
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 1_100));
    assert.equal(events[0]?.message, 'public share stage waiting');
    assert.equal(events[0]?.details?.stage, 'link-index');
    assert.ok(events[0]?.details?.elapsed_ms >= 1_000);
    assert.doesNotMatch(JSON.stringify(events), new RegExp(code));
    release(null);
    assert.equal((await pending).status, 404);
    assert.equal(events[1]?.message, 'public share stage ended');
  } finally {
    release?.(null);
    console.warn = originalWarn;
  }
});

test('shared file streams from the owner account, supports seeking and download, and stops after revocation', async () => {
  const code = 'b'.repeat(32);
  const identity = `1f:${'c'.repeat(64)}`;
  const bytes = new TextEncoder().encode('recorded together');
  let open = true;
  let reads = 0;
  const views = [];
  const person = {
    resolveRecordShare: async (_code, recipient) => {
      views.push(recipient.record_view);
      if (!open) throw new Error('This share link has ended.');
      return { kind: 'file', title: 'Morgan & Sam.mp4', body: { identity, byte_length: bytes.length, media_type: 'video/mp4' } };
    },
    namespaceLocate: async asked => asked === identity ? { identity, byte_length: bytes.length, media_type: 'video/mp4', origin: 'bucket', key: 'one-file', names: ['/media/Morgan & Sam.mp4'] } : null,
    ownerUserId: async () => 'sam-account',
    namespaceAttachedOrigins: async () => [],
  };
  const env = {
    APP_KV: { get: async key => key === `${RECORD_SHARE_LINK_INDEX}${code}` ? { person_ref: 'durable-object-id' } : null },
    PERSON: { idFromString: id => id, idFromName: name => { assert.equal(name, 'sam-account'); return name; }, get: () => withShareFileAccess(person) },
    NAMESPACE_ORIGINS: JSON.stringify([{ id: 'bucket', interface: 'object-bucket', binding: 'FILE_BUCKET' }]),
    FILE_BUCKET: { get: async (key, { range }) => {
      assert.equal(key, 'one-file'); reads += 1;
      return { body: bytes.slice(range.offset, range.offset + range.length) };
    } },
  };
  const answer = (path = '/file', init = {}) => answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}${path}`, init), { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai' });
  const preflight = await answer('/file', { method: 'OPTIONS', headers: {
    origin: 'https://example.org', 'access-control-request-method': 'GET', 'access-control-request-headers': 'range',
  } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'range');
  const whole = await answer();
  assert.equal(whole.status, 200);
  assert.equal(await whole.text(), 'recorded together');
  assert.equal(whole.headers.get('cache-control'), 'private, no-store');
  const part = await answer('/file', { headers: { range: 'bytes=9-16', origin: 'https://example.org' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 9-16/${bytes.length}`);
  assert.equal(part.headers.get('access-control-allow-origin'), '*', 'any website with this link can fetch its permitted bytes');
  assert.match(part.headers.get('access-control-expose-headers') ?? '', /content-range/);
  assert.equal(await part.text(), 'together');
  const suffix = await answer('/file', { headers: { range: 'bytes=-8' } });
  assert.equal(suffix.headers.get('content-range'), `bytes ${bytes.length - 8}-${bytes.length - 1}/${bytes.length}`);
  assert.equal(await suffix.text(), 'together');
  const head = await answer('/file', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(bytes.length));
  assert.equal(reads, 3, 'HEAD does not read bytes');
  const download = await answer('/file?download=1');
  assert.match(download.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''Morgan%20%26%20Sam.mp4$/);
  assert.equal((await answer('/file', { headers: { range: 'bytes=99-' } })).status, 416);
  assert.deepEqual(views, [false, false, false, false, false, false], 'byte requests do not append page-view events');
  open = false;
  const revoked = await answer('/file', { headers: { origin: 'https://example.org' } });
  assert.equal(revoked.status, 404);
  assert.equal(revoked.headers.get('access-control-allow-origin'), '*', 'an embedding site can see that the grant ended');
});

test('public multipart ranges reuse one checked grant, stream exact slices and refuse revoked or malformed reads', async () => {
  const code = 'm'.repeat(32);
  const identity = `1f:${'d'.repeat(64)}`;
  const bytes = new TextEncoder().encode('0123456789abcdefghijklmnopqrstuv');
  let admitted = true;
  let grants = 0;
  const reads = [];
  const firstSpan = { ordinal: 0, offset: 0, length: 16, chunk: `1f:${'e'.repeat(64)}`, origin: 'attached', key: 'first', stored: true };
  const lastSpan = { ordinal: 1, offset: 16, length: 16, chunk: `1f:${'f'.repeat(64)}`, origin: 'attached', key: 'last', stored: true };
  const person = {
    async sharedFileForLink() {
      grants += 1;
      if (!admitted) return { denied: true };
      return { copy: { kind: 'file', title: 'sample.bin', body: { identity } },
        row: { identity, byte_length: bytes.length, media_type: 'application/octet-stream', spans: 2 },
        owner_user_id: 'owner', first_spans: [firstSpan],
        attached_origins: [{ id: 'attached', interface: 'object-bucket', binding: 'ATTACHED_BUCKET' }] };
    },
    namespaceAttachedOrigins() { throw new Error('A multipart member started another origin-owner call.'); },
    namespaceSpansObserved: async (_id, start, end) => {
      assert.equal(start, 20); assert.equal(end, 23);
      return { spans: [lastSpan], lookup_ms: 0 };
    },
  };
  const env = {
    APP_KV: { get: async () => ({ person_ref: 'owner-store' }) },
    PERSON: { idFromString: id => id, idFromName: id => id, get: () => person },
    NAMESPACE_ORIGINS: '[]',
    ATTACHED_BUCKET: { get: async (key, { range }) => {
      reads.push({ key, ...range });
      const base = key === 'last' ? 16 : 0;
      return { body: bytes.slice(base + range.offset, base + range.offset + range.length) };
    } },
  };
  const answer = (range = 'bytes=0-3,20-23', method = 'GET') => answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}/file`,
    { method, headers: { range, origin: 'https://outside.example' } }), { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai' });
  const part = await answer();
  assert.equal(part.status, 206);
  assert.equal(grants, 1);
  assert.equal(reads.length, 1, 'the first byte promise opens only the first member');
  assert.equal(part.headers.get('content-range'), null);
  assert.equal(part.headers.get('access-control-allow-origin'), '*');
  const boundary = part.headers.get('content-type').split('boundary=')[1];
  const expected = `--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes 0-3/32\r\n\r\n0123\r\n`
    + `--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes 20-23/32\r\n\r\nklmn\r\n--${boundary}--\r\n`;
  assert.equal(await part.text(), expected);
  assert.equal(part.headers.get('content-length'), String(Buffer.byteLength(expected)));
  assert.deepEqual(reads, [{ key: 'first', offset: 0, length: 4 }, { key: 'last', offset: 4, length: 4 }]);
  assert.equal((await answer(undefined, 'HEAD')).status, 206);
  assert.equal(reads.length, 2, 'multipart HEAD does not read storage');
  for (const range of ['bytes=0-3,nonsense', 'bytes=0-3,', 'bytes=9007199254740992-', 'bytes=99-']) {
    const denied = await answer(range);
    assert.equal(denied.status, 416);
    assert.equal(denied.headers.get('content-range'), 'bytes */32');
  }
  assert.equal(reads.length, 2, 'invalid requests do not start a storage read');
  admitted = false;
  assert.equal((await answer()).status, 404);
  assert.equal(reads.length, 2);
  assert.equal(grants, 7, 'each HTTP read rechecks the current grant including HEAD and denials');
});

test('a public file range rechecks its grant and reuses that grant\'s attached origin', async () => {
  const code = 'h'.repeat(32);
  const identity = `1f:${'e'.repeat(64)}`;
  const bytes = new TextEncoder().encode('one checked range');
  let open = true;
  let grants = 0;
  let originReads = 0;
  const person = {
    async sharedFileForLink() {
      grants += 1;
      if (!open) throw new Error('This share link has ended.');
      return {
        copy: { kind: 'file', title: 'clip', body: { identity } },
        row: { identity, byte_length: bytes.length, media_type: 'video/mp4', origin: 'attached', key: 'clip' },
        owner_user_id: 'owner',
        attached_origins: [{ id: 'attached', interface: 'object-bucket', binding: 'ATTACHED_BUCKET' }],
      };
    },
    async namespaceAttachedOrigins() { throw new Error('A byte range must not start another owner call.'); },
  };
  const env = {
    APP_KV: { get: async () => ({ person_ref: 'owner-store' }) },
    PERSON: { idFromString: id => id, idFromName: id => id, get: () => person },
    NAMESPACE_ORIGINS: '[]',
    ATTACHED_BUCKET: { get: async (_key, { range }) => {
      originReads += 1;
      return { body: bytes.slice(range.offset, range.offset + range.length) };
    } },
  };
  const answer = () => answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}/file`,
    { headers: { range: 'bytes=0-6' } }), { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai' });
  const range = await answer();
  assert.equal(range.status, 206);
  assert.equal(await range.text(), 'one che');
  assert.equal(grants, 1);
  assert.equal(originReads, 1);
  assert.doesNotMatch(range.headers.get('server-timing') ?? '', /origin_person/);
  open = false;
  assert.equal((await answer()).status, 404);
  assert.equal(grants, 2, 'the next range checks the current grant before storage');
  assert.equal(originReads, 1);
});

test('a browser preview plays the compatible rendition while Download keeps the camera original', async () => {
  const code = 'f'.repeat(32);
  const original = `1f:${'a'.repeat(64)}`;
  const preview = `1f:${'b'.repeat(64)}`;
  const poster = `1f:${'c'.repeat(64)}`;
  const files = new Map([
    [original, { identity: original, byte_length: 8, media_type: 'application/octet-stream', origin: 'bucket', key: 'original', names: ['/recordings/C9431.MP4'] }],
    [preview, { identity: preview, byte_length: 7, media_type: 'video/mp4', origin: 'bucket', key: 'preview', names: ['/previews/C9431.mp4'] }],
    [poster, { identity: poster, byte_length: 6, media_type: 'image/jpeg', origin: 'bucket', key: 'poster', names: ['/previews/C9431.jpg'] }],
  ]);
  let open = true;
  const person = {
    resolveRecordShare: async () => {
      if (!open) throw new Error('This share link has ended.');
      return { kind: 'file', title: 'C9431.MP4', body: { identity: original, name: '/recordings/C9431.MP4', media_type: 'application/octet-stream', byte_length: 8, preview_identity: preview, preview_media_type: 'video/mp4', poster_identity: poster, poster_media_type: 'image/jpeg' } };
    },
    namespaceLocate: async identity => files.get(identity) ?? null,
    ownerUserId: async () => 'owner',
    namespaceAttachedOrigins: async () => [],
  };
  const env = {
    APP_KV: { get: async () => ({ person_ref: 'owner-store' }) },
    PERSON: { idFromString: id => id, idFromName: id => id, get: () => withShareFileAccess(person) },
    NAMESPACE_ORIGINS: JSON.stringify([{ id: 'bucket', interface: 'object-bucket', binding: 'FILE_BUCKET' }]),
    FILE_BUCKET: { get: async key => ({ body: new TextEncoder().encode(key === 'preview' ? 'preview' : key === 'poster' ? 'poster' : 'original') }) },
  };
  const answer = (path, init) => answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}${path}`, init), { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai' });
  const page = await answer('');
  const html = await page.text();
  assert.match(html, new RegExp(`/share/${code}/preview`));
  assert.match(html, new RegExp(`/share/${code}/poster`));
  assert.match(html, /<img class="page-media-poster"[^>]+loading="eager" fetchpriority="high"/);
  assert.equal(await (await answer('/preview')).text(), 'preview');
  const still = await answer('/poster');
  assert.equal(still.headers.get('content-type'), 'image/jpeg');
  assert.equal(await still.text(), 'poster');
  const download = await answer('/file?download=1');
  assert.equal(await download.text(), 'original');
  assert.match(download.headers.get('content-disposition'), /^attachment/);
  assert.equal(download.headers.get('content-type'), 'video/mp4');
  open = false;
  assert.equal((await answer('/preview')).status, 404);
  assert.equal((await answer('/poster')).status, 404);
});

test('open-ended video preview ranges return one bounded block while original downloads stay whole', async () => {
  const code = 'g'.repeat(32);
  const original = `1f:${'a'.repeat(64)}`;
  const preview = `1f:${'b'.repeat(64)}`;
  const bytes = new Uint8Array(HOT_PREFIX_BYTES + 512).fill(42);
  const rows = new Map([
    [original, { identity: original, byte_length: bytes.length, media_type: 'video/mp4', origin: 'bucket', key: 'original', names: ['/recordings/Original.mp4'] }],
    [preview, { identity: preview, byte_length: bytes.length, media_type: 'video/mp4', origin: 'bucket', key: 'preview', names: ['/previews/Preview.mp4'] }],
  ]);
  let open = true;
  const ownerRanges = [];
  const person = withShareFileAccess({
    resolveRecordShare: async () => {
      if (!open) throw new Error('This share link has ended.');
      return { kind: 'file', title: 'Original.mp4', body: { identity: original, preview_identity: preview } };
    },
    namespaceLocate: async identity => rows.get(identity) ?? null,
    ownerUserId: async () => 'owner',
    namespaceAttachedOrigins: async () => [],
  });
  const ownerRead = person.sharedFileForLink;
  person.sharedFileForLink = async (...args) => {
    ownerRanges.push(args[3]);
    return ownerRead(...args);
  };
  const env = {
    APP_KV: { get: async () => ({ person_ref: 'owner-store' }) },
    PERSON: { idFromString: id => id, idFromName: id => id, get: () => person },
    NAMESPACE_ORIGINS: JSON.stringify([{ id: 'bucket', interface: 'object-bucket', binding: 'FILE_BUCKET' }]),
    FILE_BUCKET: { get: async (_key, { range }) => ({ body: bytes.slice(range.offset, range.offset + range.length) }) },
  };
  const answer = (path, init = {}) => answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}${path}`, init), { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai' });
  const head = await answer('/preview', { method: 'HEAD', headers: { range: 'bytes=0-' } });
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('content-range'), `bytes 0-${HOT_PREFIX_BYTES - 1}/${bytes.length}`);
  assert.equal(head.headers.get('content-length'), String(HOT_PREFIX_BYTES));
  const first = await answer('/preview', { headers: { range: 'bytes=0-' } });
  assert.equal(first.status, 206);
  assert.equal((await first.arrayBuffer()).byteLength, HOT_PREFIX_BYTES);
  const rest = await answer('/preview', { headers: { range: `bytes=${HOT_PREFIX_BYTES}-` } });
  assert.equal(rest.headers.get('content-range'), `bytes ${HOT_PREFIX_BYTES}-${bytes.length - 1}/${bytes.length}`);
  assert.equal((await rest.arrayBuffer()).byteLength, 512);
  const explicit = await answer('/preview', { headers: { range: `bytes=0-${bytes.length - 1}` } });
  assert.equal((await explicit.arrayBuffer()).byteLength, bytes.length, 'an explicit range retains its requested end');
  const download = await answer('/file?download=1', { headers: { range: 'bytes=0-' } });
  assert.equal((await download.arrayBuffer()).byteLength, bytes.length, 'the original download is not capped');
  assert.deepEqual(ownerRanges, [`bytes=0-${HOT_PREFIX_BYTES - 1}`, `bytes=0-${HOT_PREFIX_BYTES - 1}`,
    `bytes=${HOT_PREFIX_BYTES}-${HOT_PREFIX_BYTES * 2 - 1}`, `bytes=0-${bytes.length - 1}`, 'bytes=0-']);
  open = false;
  assert.equal((await answer('/preview', { headers: { range: 'bytes=0-' } })).status, 404);
});

test('an indexed MP4 with generic stored type still plays and downloads as video', async () => {
  const code = 'e'.repeat(48);
  const identity = `1f:${'1'.repeat(64)}`;
  const person = {
    resolveRecordShare: async () => ({ kind: 'file', title: 'C9431.MP4', body: { identity, name: '/Recordings/C9431.MP4', byte_length: 32, media_type: 'application/octet-stream' } }),
    namespaceLocate: async () => ({ identity, byte_length: 32, media_type: 'application/octet-stream', names: ['/Recordings/C9431.MP4'] }),
    ownerUserId: async () => 'sam-account',
  };
  const env = { APP_KV: { get: async () => ({ person_ref: 'owner' }) }, PERSON: { idFromString: id => id, get: () => withShareFileAccess(person) } };
  const answer = (path, method = 'GET') => answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}${path}`, { method }), { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai' });
  const page = await answer('');
  assert.match(await page.text(), /data-media-playback-type="video\/mp4"/);
  const file = await answer('/file', 'HEAD');
  assert.equal(file.headers.get('content-type'), 'video/mp4');
  assert.equal(file.headers.get('content-length'), '32');
});

test('recipient-bound pages fail closed and code-scoped file controls carry the access code', async () => {
  const code = 'd'.repeat(32);
  const seen = [];
  const person = { resolveRecordShare: async (_code, recipient) => {
    seen.push(recipient);
    if (recipient.access_code !== 'separate-secret') throw new Error('This share link is for someone else, or needs its access code.');
    return { kind: 'file', title: 'For Morgan', body: { identity: 'file-id', media_type: 'video/mp4', byte_length: 12 } };
  } };
  const env = { APP_KV: { get: async () => ({ person_ref: 'durable-object-id' }) }, PERSON: { idFromString: id => id, get: () => withShareFileAccess(person) } };
  const page = path => answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}${path}`), { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai' });
  assert.equal((await page('')).status, 404);
  const allowed = await page('?access_code=separate-secret');
  assert.equal(allowed.status, 200);
  const html = await allowed.text();
  assert.match(html, /\/file\?access_code=separate-secret/);
  assert.match(html, /\/file\?access_code=separate-secret&amp;download=1/);
  assert.match(html, /\/transcript\?access_code=separate-secret/);
  assert.equal(seen[0].asking_relay, undefined);
});

test('shared timed words use the same revocable grant and return no namespace aliases', async () => {
  const code = 't'.repeat(32);
  const identity = `1f:${'a'.repeat(64)}`;
  let open = true;
  const calls = [];
  const person = {
    resolveRecordShare: async () => {
      if (!open) throw new Error('This share link has ended.');
      return { kind: 'file', title: 'Together.mp4', body: { identity, media_type: 'video/mp4' } };
    },
    namespaceLocate: async asked => asked === identity ? { identity } : null,
    namespaceResults: async (...args) => {
      calls.push(args);
      return new Blob([JSON.stringify({ identity, identities: [identity, 'private-alias'], results: [{ value: { text: 'Hello there', segments: [{ start: 0, end: 1, text: 'Hello there' }] } }] })]).stream();
    },
  };
  const env = { APP_KV: { get: async () => ({ person_ref: 'owner' }) }, PERSON: { idFromString: id => id, get: () => withShareFileAccess(person) } };
  const answer = (path, init) => answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}${path}`, init), { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai' });
  const page = await answer('');
  assert.match(await page.text(), new RegExp(`/share/${code}/transcript`));
  const transcript = await answer('/transcript');
  assert.equal(transcript.status, 200);
  assert.equal(transcript.headers.get('cache-control'), 'private, no-store');
  const body = await transcript.text();
  assert.deepEqual(JSON.parse(body), { text: 'Hello there', segments: [{ start: 0, end: 1, text: 'Hello there' }] });
  assert.doesNotMatch(body, /private-alias/);
  assert.deepEqual(calls[0], ['readBody', identity, 'transcript', 'public-share']);
  const head = await answer('/transcript', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  open = false;
  assert.equal((await answer('/transcript')).status, 404);
});

test('a linked plain transcript uses the existing private audio grant transcript endpoint without invented timing', async () => {
  const code = 'l'.repeat(32), identity = `1f:${'d'.repeat(64)}`;
  let open = true;
  const person = {
    resolveRecordShare: async () => open
      ? { kind: 'file', title: 'Design review.m4a', body: { identity, media_type: 'audio/mp4', transcript_identity: `1f:${'e'.repeat(64)}` } }
      : null,
    namespaceLocate: async asked => asked === identity ? { identity, media_type: 'audio/mp4', byte_length: 12 } : null,
    readSharedTranscript: async ({ identity: selected }) => {
      if (!open) throw new Error('This share link has ended.');
      assert.equal(selected, identity);
      return { text: 'The corrected words from the explicitly linked transcript.', segments: [] };
    },
  };
  const env = { APP_KV: { get: async () => ({ person_ref: 'owner' }) }, PERSON: { idFromString: id => id, get: () => withShareFileAccess(person) } };
  const answer = path => answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}${path}`), { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai', shareOwnerFor: async () => withShareFileAccess(person) });
  const page = await answer('');
  assert.match(await page.text(), new RegExp(`/share/${code}/transcript`));
  const transcript = await answer('/transcript');
  assert.equal(transcript.status, 200);
  assert.deepEqual(await transcript.json(), { text: 'The corrected words from the explicitly linked transcript.', segments: [] });
  open = false;
  assert.equal((await answer('/transcript')).status, 404, 'the existing grant revocation still fences the transcript');
});

test('non-file shares show the shareable record preview as escaped text', async () => {
  const code = 'e'.repeat(32);
  const person = { resolveRecordShare: async () => ({ kind: 'workflow', title: 'A useful workflow', body: { steps: [{ id: 'watch', do: 'Watch the selected clips.' }] }, preview: { fields: [{ label: 'Goal', value: '<script>not markup</script>' }, { id: 'steps', label: 'Steps', value: '[{"id":"watch","do":"Watch the selected clips."}]' }] } }) };
  const env = { APP_KV: { get: async () => ({ person_ref: 'durable-object-id' }) }, PERSON: { idFromString: id => id, get: () => withShareFileAccess(person) } };
  const page = await answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}`), { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai' });
  const html = await page.text();
  assert.match(html, /A useful workflow/);
  assert.match(html, /page-layout page-layout--share/);
  assert.match(html, /\/workspace\/public-share\.css/);
  assert.doesNotMatch(html, /\/workspace\/share-view\.js/);
  assert.match(html, /&lt;script&gt;not markup&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>not markup<\/script>/);
  assert.match(html, /1\. Watch the selected clips\./);
  assert.doesNotMatch(html, /\{&quot;id&quot;:/);
});

test('a collection scans as covers and opens each file with one player and its own download', async () => {
  const code = 'c'.repeat(48);
  let open = true;
  const items = ['first', 'second'].map((name, index) => ({ kind: 'file', title: `${name}.mp4`, body: {
    identity: name, name: `${name}.mp4`, byte_length: 12, media_type: 'video/mp4',
    poster_identity: `1f:${String(index + 1).repeat(64)}`, poster_media_type: 'image/jpeg',
  } }));
  const person = {
    resolveRecordShare: async (_code, recipient) => {
      if (!open) throw new Error('This share link has ended.');
      return recipient.item_index === undefined ? { kind: 'collection', title: '2 shared items', items } : items[recipient.item_index] ?? null;
    },
    namespaceLocate: async identity => ({ identity, byte_length: 12, media_type: 'video/mp4', names: [`${identity}.mp4`] }),
    ownerUserId: async () => 'owner',
  };
  const env = { APP_KV: { get: async () => ({ person_ref: 'owner-store' }) }, PERSON: { idFromString: id => id, get: () => withShareFileAccess(person) } };
  const answer = (path, init) => answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}${path}`, init), { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai' });
  const page = await answer('');
  const html = await page.text();
  assert.doesNotMatch(html, /<p class="page-eyebrow">/);
  assert.match(html, /page-section--share-collection/);
  assert.equal([...html.matchAll(/class="page-card-cover-image"/g)].length, 2);
  assert.match(html, new RegExp(`/share/${code}\\?item=0`));
  assert.match(html, new RegExp(`/share/${code}\\?item=1`));
  assert.doesNotMatch(html, /<div class="page-media page-media-player"|<script[^>]*share-view\.js|download=1/, 'the overview does not mount every player or load originals');
  const focused = await (await answer('?item=1')).text();
  assert.match(focused, new RegExp(`/share/${code}/items/1/file\\?download=1`));
  assert.match(focused, /page-media-player/);
  assert.match(focused, /items\/1\/poster/);
  assert.match(focused, /page-media-poster[^>]*loading="eager" fetchpriority="high"/);
  assert.match(focused, new RegExp(`/share/${code}"[^>]*>All shared items`));
  assert.equal((await answer('/items/1/file?download=1', { method: 'HEAD' })).headers.get('content-disposition'), "attachment; filename*=UTF-8''second.mp4");
  assert.equal((await answer('/items/2/file', { method: 'HEAD' })).status, 404);
  assert.equal((await answer('?item=2')).status, 404);
  open = false;
  assert.equal((await answer('?item=1')).status, 404);
  assert.equal((await answer('/items/0/file', { method: 'HEAD' })).status, 404);
});

test('shared image cards use a bounded original or a saved cover through the current grant', async () => {
  const code = 'i'.repeat(48);
  const smallId = `1f:${'1'.repeat(64)}`;
  const largeId = `1f:${'2'.repeat(64)}`;
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zkq0AAAAASUVORK5CYII='), char => char.charCodeAt(0));
  const items = [
    { kind: 'file', title: 'small.png', body: { identity: smallId, name: 'small.png', media_type: 'image/png', byte_length: png.length } },
    { kind: 'file', title: 'large.png', body: { identity: largeId, name: 'large.png', media_type: 'image/png', byte_length: 10 } },
  ];
  let open = true;
  let savedCover = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
  let originReads = 0;
  const coverCalls = [];
  const rows = new Map([
    [smallId, { identity: smallId, byte_length: png.length, media_type: 'image/png', origin: 'bucket', key: 'small', names: ['small.png'] }],
    [largeId, { identity: largeId, byte_length: 8 * 1024 * 1024, media_type: 'image/png', origin: 'bucket', key: 'large', names: ['large.png'] }],
  ]);
  const person = withShareFileAccess({
    async shareAccess() { return { admitted: open, public: true, needs: null, closed: !open, can: ['view'], acts_need_proof: false,
      proven: false, sender: 'Ana', look: { kind: 'trillion', name: 'Trillion' }, signatures: [], signed_by_you: false, paid: false }; },
    async resolveRecordShare(_code, recipient) {
      if (!open) throw new Error('This share link has ended.');
      return recipient.item_index === undefined ? { kind: 'collection', title: 'Two pictures', items } : items[recipient.item_index] ?? null;
    },
    async sharedFileForLink(_code, recipient, part) {
      coverCalls.push({ item_index: recipient.item_index, part });
      if (!open) return { denied: true };
      const copy = items[recipient.item_index];
      const row = rows.get(copy?.body?.identity);
      return { copy, row, owner_user_id: 'owner',
        ...(part === 'cover' && copy?.body?.identity === largeId && savedCover
          ? { cover_poster: savedCover } : {}) };
    },
    namespaceAttachedOrigins: async () => [],
  });
  const env = {
    APP_KV: { get: async () => ({ person_ref: 'owner-store' }) },
    PERSON: { idFromString: id => id, idFromName: id => id, get: () => person },
    NAMESPACE_ORIGINS: JSON.stringify([{ id: 'bucket', interface: 'object-bucket', binding: 'FILE_BUCKET' }]),
    FILE_BUCKET: { get: async (_key, { range } = {}) => { originReads += 1; return { body: range ? png.slice(range.offset, range.offset + range.length) : png }; } },
  };
  const answer = path => answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}${path}`),
    { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai' });
  const html = await (await answer('')).text();
  assert.match(html, new RegExp(`/share/${code}/items/0/cover`));
  assert.match(html, new RegExp(`/share/${code}/items/1/cover`));
  assert.doesNotMatch(html, /page-card-cover-image[^>]+\/items\/1\/file/);
  assert.match(html, new RegExp(`<meta property="og:image" content="https://app.gettrillion.ai/share/${code}/items/0/cover"/>`));
  const json = await (await answer('.json')).json();
  assert.equal(json.items[0].cover_url, `https://app.gettrillion.ai/share/${code}/items/0/cover`);

  const small = await answer('/items/0/cover');
  assert.equal(small.status, 200);
  assert.equal(small.headers.get('content-type'), 'image/png');
  assert.deepEqual(new Uint8Array(await small.arrayBuffer()), png);
  assert.equal(originReads, 1);

  const large = await answer('/items/1/cover');
  assert.deepEqual(coverCalls.at(-1), { item_index: 1, part: 'cover' });
  assert.equal(large.headers.get('x-cover-source'), 'saved-preview');
  assert.deepEqual(new Uint8Array(await large.arrayBuffer()), png);
  assert.equal(originReads, 1, 'the large original is never read for a gallery cover');

  savedCover = 'data:image/svg+xml;base64,PHN2Zy8+';
  const unsafe = await answer('/items/1/cover');
  assert.equal(unsafe.headers.get('x-cover-source'), 'kind-glyph', 'active image types are not served from a saved preview');
  savedCover = `data:image/png;base64,${'A'.repeat(400_000)}`;
  const oversized = await answer('/items/1/cover');
  assert.equal(oversized.headers.get('x-cover-source'), 'kind-glyph', 'an oversized preview never reaches the card');
  savedCover = null;
  const absent = await answer('/items/1/cover');
  assert.equal(absent.headers.get('x-cover-source'), 'kind-glyph');
  assert.equal(originReads, 1, 'a missing preview does not read the large original');
  open = false;
  assert.equal((await answer('/items/0/cover')).status, 404);
  assert.equal((await answer('/items/1/cover')).status, 404);
});

test('a public single image advertises its bounded cover to messaging link cards', async () => {
  const code = 'o'.repeat(48);
  const copy = { kind: 'file', title: 'portrait.webp', body: { identity: `1f:${'3'.repeat(64)}`,
    name: 'portrait.webp', media_type: 'image/webp', byte_length: 1024 } };
  const person = { async sharedPageForLink() { return { copy, access: { admitted: true, public: true, closed: false,
    can: ['view'], look: { kind: 'trillion', name: 'Trillion' }, signatures: [], signed_by_you: false, paid: false } }; } };
  const env = { APP_KV: { get: async () => ({ person_ref: 'owner-store' }) },
    PERSON: { idFromString: id => id, get: () => person } };
  const response = await answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}`),
    { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai' });
  assert.match(await response.text(), new RegExp(`<meta property="og:image" content="https://app.gettrillion.ai/share/${code}/cover"/>`));
});

test('only an anonymous public collection advertises its grant-checked first poster to link-card crawlers', async () => {
  const code = 'p'.repeat(48);
  const poster = `1f:${'a'.repeat(64)}`;
  const original = `1f:${'b'.repeat(64)}`;
  const items = [
    { kind: 'workflow', title: 'Editing steps', preview: { fields: [] } },
    { kind: 'file', title: 'First clip.mp4', body: { identity: original, media_type: 'video/mp4', byte_length: 8,
      poster_identity: poster, poster_media_type: 'image/jpeg' } },
  ];
  let publiclyOpen = true;
  let open = true;
  const person = withShareFileAccess({
    async shareAccess(_code, recipient) {
      const admitted = open && (publiclyOpen || recipient.relay === 'recipient');
      return { admitted, public: publiclyOpen, closed: !open, needs: admitted ? null : 'account', can: ['view'],
        acts_need_proof: false, proven: recipient.relay === 'recipient', sender: 'Ana',
        look: { kind: 'trillion', name: 'Trillion' }, signatures: [], signed_by_you: false, paid: false };
    },
    async resolveRecordShare(_code, recipient) {
      if (!open || (!publiclyOpen && recipient.relay !== 'recipient')) throw new Error('This share link is for someone else, or needs its access code.');
      return recipient.item_index === undefined ? { kind: 'collection', title: 'Two shared items', items } : items[recipient.item_index] ?? null;
    },
    async sharedFileForLink(_code, recipient, part) {
      const copy = await this.resolveRecordShare(_code, recipient);
      const identity = part === 'poster' ? copy?.body?.poster_identity : copy?.body?.identity;
      const row = identity === poster ? { identity, byte_length: 6, media_type: 'image/jpeg', origin: 'bucket', key: 'poster', names: ['poster.jpg'] }
        : identity === original ? { identity, byte_length: 8, media_type: 'video/mp4', origin: 'bucket', key: 'original', names: ['clip.mp4'] } : null;
      return { copy, row, owner_user_id: row ? 'owner' : null };
    },
    namespaceAttachedOrigins: async () => [],
  });
  const kv = { get: async () => ({ person_ref: 'owner-store' }) };
  const env = { APP_KV: kv, PERSON: { idFromString: id => id, idFromName: id => id, get: () => person },
    NAMESPACE_ORIGINS: JSON.stringify([{ id: 'bucket', interface: 'object-bucket', binding: 'FILE_BUCKET' }]),
    FILE_BUCKET: { get: async key => ({ body: new TextEncoder().encode(key === 'poster' ? 'poster' : 'original') }) } };
  const origin = 'https://app.gettrillion.ai';
  const answer = (path = '', session = null) => answerRecordShare(new Request(`${origin}/share/${code}${path}`, {
    headers: { 'user-agent': 'facebookexternalhit/1.1' },
  }), { env, kv, origin, session });

  const publicHtml = await (await answer()).text();
  const posterUrl = `${origin}/share/${code}/items/1/poster`;
  assert.match(publicHtml, new RegExp(`<meta property="og:image" content="${posterUrl}"/>`));
  assert.match(publicHtml, new RegExp(`<meta name="twitter:image" content="${posterUrl}"/>`));
  assert.match(publicHtml, /<meta name="twitter:card" content="summary_large_image"\/>/);
  assert.match(publicHtml, /<meta property="og:image:alt" content="Preview of First clip.mp4"\/>/);
  const publicPoster = await answer('/items/1/poster');
  assert.equal(publicPoster.status, 200);
  assert.equal(publicPoster.headers.get('content-type'), 'image/jpeg');
  assert.equal(await publicPoster.text(), 'poster');

  publiclyOpen = false;
  const privateHtml = await (await answer('', { relay: 'recipient' })).text();
  assert.match(privateHtml, /<meta property="og:image" content="https:\/\/app\.gettrillion\.ai\/icon-512\.png"\/>/);
  assert.match(privateHtml, /<meta name="twitter:card" content="summary"\/>/);
  assert.equal((await answer('/items/1/poster')).status, 404, 'an anonymous crawler cannot read a recipient-bound poster');
  assert.equal((await answer('/items/1/poster', { relay: 'recipient' })).status, 200);

  publiclyOpen = true;
  const keptPoster = items[1].body.poster_identity;
  delete items[1].body.poster_identity;
  const noPosterHtml = await (await answer()).text();
  assert.match(noPosterHtml, /<meta property="og:image" content="https:\/\/app\.gettrillion\.ai\/icon-512\.png"\/>/);
  items[1].body.poster_identity = keptPoster;
  open = false;
  assert.equal((await answer('/items/1/poster')).status, 404, 'revocation closes the image URL advertised earlier');
  assert.doesNotMatch(await (await answer()).text(), new RegExp(`/items/1/poster`), 'a revoked link cannot advertise the poster');
});

test('focused collection social cards describe the selected record without borrowing a sibling picture', async () => {
  const code = 's'.repeat(48);
  const origin = 'https://app.gettrillion.ai';
  const poster = `1f:${'a'.repeat(64)}`;
  const file = (title, mediaType, extra = {}) => ({ kind: 'file', title,
    body: { identity: `1f:${'b'.repeat(64)}`, media_type: mediaType, byte_length: 8, ...extra } });
  const video = title => file(title, 'video/mp4', { poster_identity: poster, poster_media_type: 'image/jpeg' });
  const items = [
    video('First clip.mp4'),
    video('Second & clip.mp4'),
    file('Portrait.png', 'image/png'),
    { kind: 'workflow', title: 'Review the cut', body: { steps: [{ do: 'Review the selected cut.' }] } },
    { kind: 'text', title: 'A note', body: { text: 'Keep the opening.' } },
    { kind: 'link', title: 'Reference', body: { url: 'https://example.com/reference' } },
    file('Voice.mp3', 'audio/mpeg'),
    file('Agreement.pdf', 'application/pdf'),
    file('No poster.mp4', 'video/mp4'),
    file('Large image.png', 'image/png', { byte_length: 10_000_000 }),
    { kind: 'withdrawn', title: 'No longer shared' },
    { kind: 'record:task', title: 'Check the edit' },
    file('Next page.png', 'image/png'),
    video('Later clip.mp4'),
    { kind: 'text', body: { text: 'An untitled note.' } },
    { kind: 'record:project', title: 'The project' },
  ];
  for (const [index, item] of items.entries()) item.preview = { fields: [{ label: 'Summary', value: `Selected description ${index}` }] };
  let publiclyOpen = true;
  const pageOptions = [];
  const person = {
    async sharedPageForLink(_code, _recipient, { item_offset = 0, item_limit = 12 } = {}) {
      pageOptions.push({ offset: item_offset, limit: item_limit });
      return {
        access: { admitted: true, public: publiclyOpen, listed: true, can: ['view'], acts_need_proof: false,
          look: { kind: 'trillion', name: 'Trillion' }, signatures: [], signed_by_you: false },
        copy: { kind: 'collection', title: 'Shared work', item_offset, item_count: items.length,
          has_more: item_offset + item_limit < items.length, items: items.slice(item_offset, item_offset + item_limit),
          preview: { fields: [{ label: 'Summary', value: 'Collection description' }] } },
      };
    },
  };
  const kv = { get: async () => ({ person_ref: 'owner-store' }) };
  const env = { APP_KV: kv, PERSON: { idFromString: id => id, get: () => person } };
  const answer = suffix => answerRecordShare(new Request(`${origin}/share/${code}${suffix}`, {
    headers: { 'user-agent': 'facebookexternalhit/1.1' },
  }), { env, kv, origin });
  const meta = (html, attribute, name) => html.match(new RegExp(`<meta ${attribute}="${name}" content="([^"]*)"\\/>`))?.[1];
  const escaped = value => value.replaceAll('&', '&amp;');

  for (const [index, item] of items.entries()) {
    const response = await answer(`?item=${index}&access_code=private-code`);
    assert.equal(response.status, 200, `item ${index} remains readable`);
    const html = await response.text();
    const title = escaped(item.title || 'Shared item');
    assert.equal(meta(html, 'property', 'og:title'), title);
    assert.equal(meta(html, 'name', 'twitter:title'), title);
    assert.ok(html.includes(`<title>${title}</title>`));
    assert.equal(meta(html, 'property', 'og:url'), `${origin}/share/${code}?item=${index}`);
    assert.ok(html.includes(`<link rel="canonical" href="${origin}/share/${code}?item=${index}"/>`));
    assert.equal(meta(html, 'property', 'og:description'), `Selected description ${index}`);
    const picturePart = [0, 1, 13].includes(index) ? 'poster' : [2, 12].includes(index) ? 'cover' : null;
    const picture = picturePart ? `${origin}/share/${code}/items/${index}/${picturePart}` : `${origin}/icon-512.png`;
    assert.equal(meta(html, 'property', 'og:image'), picture, `item ${index} never borrows a sibling's picture`);
    assert.equal(meta(html, 'name', 'twitter:image'), picture);
    assert.equal(meta(html, 'property', 'og:image:alt'), picturePart ? `Preview of ${title}` : 'Trillion needle and red thread');
    assert.equal(meta(html, 'name', 'twitter:card'), picturePart ? 'summary_large_image' : 'summary');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
  assert.deepEqual(pageOptions, items.map((_, index) => ({ offset: Math.floor(index / 12) * 12, limit: 12 })),
    'metadata needs only the existing bounded collection read');
  for (const [suffix, index, part] of [['', 0, 'poster'], ['?offset=12', 12, 'cover']]) {
    const html = await (await answer(suffix)).text();
    assert.equal(meta(html, 'property', 'og:title'), 'Shared work');
    assert.equal(meta(html, 'property', 'og:image'), `${origin}/share/${code}/items/${index}/${part}`);
    assert.equal(meta(html, 'property', 'og:description'), 'Collection description');
    assert.equal(meta(html, 'property', 'og:url'), `${origin}/share/${code}${suffix}`);
  }
  publiclyOpen = false;
  const privateHtml = await (await answer('?item=1')).text();
  assert.equal(meta(privateHtml, 'property', 'og:title'), 'Second &amp; clip.mp4');
  assert.equal(meta(privateHtml, 'property', 'og:image'), `${origin}/icon-512.png`, 'recipient-bound shares retain the private card');
  assert.equal((await answer('?item=banana')).status, 400);
  assert.equal((await answer('?item=-1')).status, 400);
  const missing = await answer('?item=99');
  assert.equal(missing.status, 404);
  assert.equal(meta(await missing.text(), 'property', 'og:image'), `${origin}/icon-512.png`);
});

test('a large mixed collection serves bounded pages, global file links and bounded JSON through the current grant', async () => {
  const code = 'm'.repeat(48);
  const items = Array.from({ length: 70 }, (_, index) => index % 4 === 0 || index === 69
    ? { kind: 'file', title: `Clip ${index}`, body: { identity: `file-${index}`, name: `/Gallery/rough cuts/clip-${index}.mp4`, byte_length: 12, media_type: 'video/mp4' } }
    : index % 4 === 1
      ? { kind: 'text', title: `Words ${index}`, body: { text: `Words from item ${index}` } }
      : index % 4 === 2
        ? { kind: 'workflow', title: `Workflow ${index}`, body: { job: `Review cuts for item ${index}.`, steps: [{ do: `Review item ${index}.` }] },
          preview: { fields: [{ id: 'label', label: 'Name', value: `workflow:internal-${index}` }, { id: 'goal', label: 'Goal', value: `Goal ${index}` }] } }
        : { kind: 'link', title: `Link ${index}`, body: { url: `https://example.com/${index}` } });
  let open = true;
  const pageOptions = [];
  const person = withShareFileAccess({
    async resolveRecordShare(_code, recipient) {
      if (!open) throw new Error('This share link has ended.');
      if (recipient.item_index !== undefined) return items[recipient.item_index] ?? null;
      pageOptions.push({ offset: recipient.item_offset, limit: recipient.item_limit });
      const offset = recipient.item_offset ?? 0;
      const limit = recipient.item_limit ?? 32;
      return { kind: 'collection', title: '70 shared items', item_offset: offset, item_count: items.length,
        has_more: offset + limit < items.length, items: items.slice(offset, offset + limit) };
    },
    async namespaceLocate(identity) { return { identity, byte_length: 12, media_type: 'video/mp4', names: [`${identity}.mp4`] }; },
    async ownerUserId() { return 'owner'; },
  });
  const kv = { get: async () => ({ person_ref: 'owner-store' }) };
  const env = { APP_KV: kv, PERSON: { idFromString: id => id, get: () => person } };
  const answer = (path, init) => answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}${path}`, init), { env, kv, origin: 'https://app.gettrillion.ai' });
  const first = await (await answer('?access_code=secret')).text();
  assert.match(first, /Showing 1–12 of 70 items/);
  assert.match(first, new RegExp(`/share/${code}\\?item=0&amp;access_code=secret`));
  assert.match(first, new RegExp(`/share/${code}\\?offset=12&amp;access_code=secret`));
  assert.match(first, /aria-current="page"/);
  assert.equal([...first.matchAll(/class="page-card(?: page-card--[^"]+)?"/g)].length, 12);
  assert.match(first, /clip-0\.mp4/, 'a file card names the file');
  assert.doesNotMatch(first, /Gallery\/rough cuts/, 'a card does not spill a namespace path');
  assert.match(first, /Review cuts for item 2\./, 'a workflow card explains its purpose');
  assert.doesNotMatch(first, /workflow:internal-2/, 'a workflow card does not expose its internal id');
  assert.doesNotMatch(first, /<div class="page-media page-media-player"|<script[^>]*share-view\.js|items\/12\/file/);
  const second = await (await answer('?offset=12&access_code=secret')).text();
  assert.match(second, /Showing 13–24 of 70 items/);
  assert.match(second, new RegExp(`/share/${code}\\?item=12&amp;access_code=secret`));
  assert.match(second, new RegExp(`/share/${code}\\?offset=24&amp;access_code=secret`));
  assert.doesNotMatch(second, /items\/24\/file/);
  const last = await (await answer('?offset=60')).text();
  assert.match(last, /Showing 61–70 of 70 items/);
  assert.match(last, new RegExp(`/share/${code}\\?item=69`));
  assert.doesNotMatch(last, /offset=72/);
  const focused = await (await answer('?item=69&access_code=secret')).text();
  assert.match(focused, new RegExp(`/share/${code}/items/69/file\\?access_code=secret&amp;download=1`));
  assert.match(focused, /page-media-player/);
  const focusedWorkflow = await (await answer('?item=2&access_code=secret')).text();
  assert.match(focusedWorkflow, /Review item 2\./, 'a saved workflow step remains visible when preview fields omit it');
  assert.match(focusedWorkflow, /More in this link/, 'the focused item keeps nearby records visible');
  assert.equal([...focusedWorkflow.matchAll(/class="page-card(?: page-card--[^"]+)?"/g)].length, 4);
  const firstData = await (await answer('.json?access_code=secret')).json();
  assert.equal(firstData.items.length, 32);
  assert.equal(firstData.items[31].index, 31);
  assert.equal(firstData.next, `https://app.gettrillion.ai/share/${code}.json?offset=32&access_code=secret`);
  const dataResponse = await answer('.json?offset=64&access_code=secret');
  assert.equal(dataResponse.headers.get('cache-control'), 'private, no-store', 'a browser must recheck a collection grant after revocation');
  const data = await dataResponse.json();
  assert.equal(data.total_items, 70);
  assert.equal(data.offset, 64);
  assert.equal(data.items.length, 6);
  assert.equal(data.items[5].index, 69);
  assert.equal(data.items[5].file_url, `https://app.gettrillion.ai/share/${code}/items/69/file?access_code=secret`);
  assert.equal(data.items[5].download_url, `https://app.gettrillion.ai/share/${code}/items/69/file?access_code=secret&download=1`);
  assert.equal(data.next, undefined);
  assert.equal(data.previous, `https://app.gettrillion.ai/share/${code}.json?offset=32&access_code=secret`);
  assert.doesNotMatch(JSON.stringify(data), /attached_origins|origin_key/);
  assert.deepEqual(pageOptions, [{ offset: 0, limit: 12 }, { offset: 12, limit: 12 }, { offset: 60, limit: 12 },
    { offset: 60, limit: 12 }, { offset: 0, limit: 12 }, { offset: 0, limit: 32 }, { offset: 64, limit: 32 }]);
  assert.equal((await answer('/items/69/file', { method: 'HEAD' })).status, 200);
  assert.equal((await answer('.json?offset=banana')).status, 400);
  assert.equal((await answer('?item=banana')).status, 400);
  const invalidPage = await answer('?offset=banana');
  assert.equal(invalidPage.status, 400);
  assert.match(await invalidPage.text(), /page-layout--share[\s\S]*page-section--share-footer/);
  const head = await answer('.json?offset=32', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  open = false;
  assert.equal((await answer('?offset=12')).status, 404);
  assert.equal((await answer('?item=69')).status, 404);
  const revokedData = await answer('.json?offset=32');
  assert.equal(revokedData.status, 404);
  assert.equal(revokedData.headers.get('cache-control'), 'private, no-store');
});

test('collection link cards show a concise destination while the focused link keeps its full address', async () => {
  const code = 'u'.repeat(48);
  const address = `https://www.research.example.com/notes/${'long-path-'.repeat(24)}?topic=editing&view=source`;
  const items = [
    { kind: 'link', title: 'Editing reference', body: { url: address } },
    { kind: 'link', title: address, body: { url: address } },
  ];
  const person = {
    async sharedPageForLink(_code, _recipient, { item_offset = 0, item_limit = 12 } = {}) {
      return {
        access: { admitted: true, public: true, needs: null, closed: false, can: ['view'], acts_need_proof: false,
          proven: false, sender: 'Ana', look: { kind: 'trillion', name: 'Trillion' }, signatures: [], signed_by_you: false },
        copy: { kind: 'collection', title: 'Two references', item_offset, item_count: items.length,
          has_more: false, items: items.slice(item_offset, item_offset + item_limit) },
      };
    },
  };
  const kv = { get: async () => ({ person_ref: 'owner-store' }) };
  const env = { APP_KV: kv, PERSON: { idFromString: id => id, get: () => person } };
  const answer = path => answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}${path}`),
    { env, kv, origin: 'https://app.gettrillion.ai' });
  const overview = await (await answer('')).text();
  assert.match(overview, /research\.example\.com/);
  assert.doesNotMatch(overview, /long-path-|topic=editing/, 'gallery cards do not spill raw paths or query strings');
  assert.match(overview, /Editing reference/, 'a descriptive link title remains the card title');
  const focused = await (await answer('?item=0')).text();
  assert.ok(focused.includes(address.replace('&', '&amp;')), 'the focused link retains the full usable address');
});

test('a withdrawn nested slot renders without child metadata or a file address', async () => {
  const code = 'w'.repeat(48);
  const copy = { kind: 'collection', title: '3 shared items', item_offset: 0, item_count: 3, items: [
    { kind: 'text', title: 'Opening', body: { text: 'Still here' } },
    { kind: 'withdrawn', title: 'No longer shared' },
    { kind: 'file', title: 'sibling.txt', body: { identity: 'sibling', name: 'sibling.txt', byte_length: 7, media_type: 'text/plain' } },
  ] };
  const person = {
    async sharedPageForLink() { return { access: { admitted: true, can: ['view'], look: { kind: 'trillion', name: 'Trillion' }, public: true, listed: true }, copy }; },
  };
  const kv = { get: async () => ({ person_ref: 'owner-store' }) };
  const env = { APP_KV: kv, PERSON: { idFromString: id => id, get: () => person } };
  const answer = suffix => answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}${suffix}`),
    { env, kv, origin: 'https://app.gettrillion.ai' });
  const page = await answer('');
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'private, no-store', 'listed collections recheck withdrawn children on every page open');
  assert.match(html, /No longer shared/);
  assert.match(html, /This item is no longer available/);
  assert.match(html, /page-card-cover-glyph[^>]*>—<\/span>/, 'a withdrawn card has a deliberate unavailable mark, not a stray dot');
  assert.match(html, /Still here/);
  assert.match(html, /sibling\.txt/);
  assert.doesNotMatch(html, /Secret child|items\/1\/file/);
  const data = await (await answer('.json')).json();
  assert.deepEqual(data.items[1], { index: 1, kind: 'withdrawn', title: 'No longer shared', preview: null });
  assert.equal(data.items[2].file_url, `https://app.gettrillion.ai/share/${code}/items/2/file`);
});

test('sampled public reads relay only bounded storage diagnostic state', async t => {
  const probeId = '61908eb9-a1c1-45cc-badb-39e887465d40';
  const logs = [];
  t.mock.method(crypto, 'randomUUID', () => probeId);
  t.mock.method(console, 'info', (...entry) => logs.push(entry));
  const identity = `1f:${'3'.repeat(64)}`;
  let state;
  const person = { async sharedFileForLink(...args) {
    assert.equal(args[6], probeId);
    return { copy: { kind: 'file', title: 'private-name.mp4', body: { identity } },
      row: { identity, byte_length: 32, media_type: 'video/mp4', names: ['private-name.mp4'] },
      owner_user_id: 'private-owner', _timing: { storage_probe_state: state } };
  } };
  const env = { APP_KV: { get: async () => ({ person_ref: 'private-owner' }) }, PERSON: { idFromString: id => id, get: () => person } };
  for (state of ['scheduled', 'unsupported-sync', 'failed', 'private-name.mp4']) {
    const response = await answerRecordShare(new Request(`https://app.gettrillion.ai/share/${'g'.repeat(32)}/file`, { method: 'HEAD' }), { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai' });
    assert.equal(response.status, 200);
    const [label, entry] = logs.at(-1);
    assert.equal(label, 'checked read RPC returned');
    assert.deepEqual(entry, { probe_id: probeId, method: 'file-access',
      ...(state === 'private-name.mp4' ? {} : { storage_probe_state: state }) });
  }
  assert.doesNotMatch(JSON.stringify(logs), /private-name|private-owner/);
});

test('a file request resolves its grant and file in one owner call', async () => {
  const code = 'g'.repeat(32);
  const identity = `1f:${'3'.repeat(64)}`;
  let open = true;
  let ownerCalls = 0;
  const person = {
    async sharedFileForLink(_code, recipient, part, _range, _spans, callerStartedAt) {
      await new Promise(resolve => setTimeout(resolve, 20));
      ownerCalls += 1;
      assert.equal(recipient.record_view, undefined);
      assert.equal(part, 'file');
      assert.ok(Number.isFinite(callerStartedAt));
      if (!open) throw new Error('This share link has ended.');
      return { copy: { kind: 'file', title: 'clip.mp4', body: { identity } },
        row: { identity, byte_length: 32, media_type: 'video/mp4', names: ['clip.mp4'] }, owner_user_id: 'owner',
        _timing: { admission_ms: 0.01, admission_state: 'finish-failed', owner_version: '11111111-2222-3333-4444-555555555555', initial_admission_ms: 1234, constructor_ms: 2345, resolve_ms: 0.01, row_ms: 0.01, owner_first_share_read: true, meter_flush_phase: 'report', owner_arrival_ms: 4, owner_method_ms: 7 } };
    },
    resolveRecordShare() { throw new Error('A file read must not ask for a second grant turn.'); },
    namespaceLocate() { throw new Error('A file read must not ask for a second file turn.'); },
    ownerUserId() { throw new Error('A file read must not ask for a third owner turn.'); },
  };
  const env = { APP_KV: { get: async () => ({ person_ref: 'owner-store' }) }, PERSON: { idFromString: id => id, get: () => person } };
  const head = () => answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}/file`, { method: 'HEAD' }), { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai' });
  const before = await head();
  assert.equal(before.status, 200);
  assert.equal(before.headers.get('content-length'), '32');
  assert.match(before.headers.get('server-timing'), /access;dur=/);
  assert.match(before.headers.get('server-timing'), /access_admission;dur=/);
  assert.match(before.headers.get('server-timing'), /access_admission_state;desc="finish-failed"/);
  assert.match(before.headers.get('server-timing'), /owner_version;desc="11111111-2222-3333-4444-555555555555"/);
  assert.match(before.headers.get('server-timing'), /owner_initial_admission;dur=1234\.0/);
  assert.match(before.headers.get('server-timing'), /owner_constructor;dur=2345\.0/);
  assert.doesNotMatch(before.headers.get('server-timing'), /access_constructor/);
  const fileTimes = new Map([...before.headers.get('server-timing').matchAll(/(\w+);dur=([\d.]+)/g)].map(([, key, value]) => [key, Number(value)]));
  assert.ok(fileTimes.get('access_wait') > 5, 'historical work does not erase the current wait');
  assert.ok(Math.abs(fileTimes.get('access') - ['access_admission', 'access_resolve', 'access_row', 'access_wait'].reduce((sum, key) => sum + (fileTimes.get(key) ?? 0), 0)) < 0.3);
  assert.match(before.headers.get('server-timing'), /access_resolve;dur=/);
  assert.match(before.headers.get('server-timing'), /access_row;dur=/);
  assert.match(before.headers.get('server-timing'), /access_wait;dur=/);
  assert.match(before.headers.get('server-timing'), /owner_first_share_read;desc="yes"/);
  assert.match(before.headers.get('server-timing'), /meter_flush;desc="report"/);
  assert.match(before.headers.get('server-timing'), /owner_arrival;dur=/);
  assert.match(before.headers.get('server-timing'), /owner_method;dur=/);
  assert.doesNotMatch(before.headers.get('server-timing'), /clip\.mp4|owner-store/);
  assert.doesNotMatch(before.headers.get('server-timing'), /(?:file|owner);dur=/);
  assert.equal(ownerCalls, 1);
  open = false;
  assert.equal((await head()).status, 404);
  assert.equal(ownerCalls, 2, 'the grant is rechecked for each request');
});

// A deal sent to one email address, opened in a browser with no Trillion account: the visitor proves the email with a
// code (src/share-visitor.mjs), reads the deal, signs it, and the free deal is given to the account kept for that email.
test('a deal opens with no account: prove the email by code, read it, sign it', async () => {
  const { provenEmail } = await import('../src/share-visitor.mjs');
  const code = 'k'.repeat(48);
  const values = new Map([[`${RECORD_SHARE_LINK_INDEX}${code}`, JSON.stringify({ person_ref: 'seller' })]]);
  const kv = {
    get: async (key, type) => { const value = values.get(key); return value === undefined ? null : type === 'json' ? JSON.parse(value) : value; },
    put: async (key, value) => values.set(key, value),
    delete: async key => values.delete(key),
    list: async () => ({ keys: [] }),
  };
  const mail = [];
  const signed = [];
  const named = recipient => recipient.verified_email === 'bo@example.com';
  const person = {
    async shareAccess(_code, recipient) {
      return { admitted: named(recipient), needs: named(recipient) ? null : 'email', closed: false, can: ['view', 'sign'], acts_need_proof: true,
        proven: Boolean(recipient.verified_email), sender: 'Ana Lopez', look: { kind: 'own', name: 'Ana Studio', accent: '#336699' },
        signatures: signed.map(({ name, signed_at }) => ({ name, signed_at })), signed_by_you: signed.length > 0, paid: false, delivers_on_sign: true };
    },
    async resolveRecordShare(_code, recipient) {
      if (!named(recipient)) throw new Error('This share link is for someone else, or needs its access code.');
      return { kind: 'sales-contract', title: 'Free Trillion', body: { name: 'Free Trillion' }, preview: { fields: [{ label: 'Deal', value: 'Trillion, free' }] } };
    },
    async mayAdmitShareEmail(_code, {email}) { return email === 'bo@example.com'; },
    async sharePaymentTerms() { return null; },
    async signShare(_code, recipient, { name }) {
      assert.ok(named(recipient));
      signed.push({ name, buyer_ref: recipient.buyer_ref, signed_at: '2026-10-03T20:00:00.000Z' });
      return signed.at(-1);
    },
  };
  const env = { APP_KV: kv, EMAIL: { send: async message => { mail.push(message); return { messageId: 'm1' }; } }, PERSON: { idFromString: id => id, get: () => withShareFileAccess(person) } };
  const origin = 'https://app.gettrillion.ai';
  const open = async (path = '', init = {}) => {
    const request = new Request(`${origin}/share/${code}${path}`, init);
    const email = await provenEmail(request, kv);
    return answerRecordShare(request, { env, kv, origin, session: email ? { verified_email: email } : null, buyerFor: async address => `held:${address}` });
  };
  const post = (path, form, cookie = '') => open(path, { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(form) });

  const first = await open();
  const firstPage = await first.text();
  assert.match(firstPage, /No account needed/, 'a visitor proves the email on the page; signing in is only offered to someone who has an account');
  assert.equal(first.status, 200);
  assert.match(firstPage, new RegExp(`/share/${code}/prove`));
  assert.match(firstPage, /Ana Studio/, 'the page wears the sharer\'s brand');
  assert.match(firstPage, /--button-primary-bg:#336699/);
  assert.match(firstPage, /Made with/);
  assert.equal((await open('/prove', { method: 'POST', headers: { origin: 'https://elsewhere.example', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'bo@example.com' }) })).status, 403, 'a post from another site is refused');
  assert.equal(mail.length, 0);
  const uninvited = await post('/prove', {email: 'other@example.com'});
  assert.equal(uninvited.status, 200, 'email admission does not reveal who the link names');
  assert.equal(mail.length, 0, 'the current share owner refuses mail to an unrelated recipient');
  const asked = await open('/prove', { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'Bo@Example.com' }) });
  assert.equal(asked.status, 200);
  assert.equal(mail.length, 1);
  const sent = mail[0].text ?? mail[0].html ?? '';
  const proofCode = /\b(\d{6})\b/.exec(`${mail[0].subject} ${sent}`)?.[1];
  assert.ok(proofCode, 'the email carries a six-digit code');
  const wrong = await post('/prove', { email: 'bo@example.com', code: '000000' === proofCode ? '111111' : '000000' });
  assert.equal(wrong.status, 400);
  const proved = await post('/prove', { email: 'bo@example.com', code: proofCode });
  assert.equal(proved.status, 303);
  const cookie = proved.headers.get('set-cookie').split(';')[0];
  assert.match(proved.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax; Path=\/share\//);
  const page = await (await open('', { headers: { cookie } })).text();
  assert.match(page, /Trillion, free/);
  assert.match(page, new RegExp(`/share/${code}/sign`));
  const signing = await post('/sign', { name: 'Bo Buyer' }, cookie);
  assert.equal(signing.status, 303);
  assert.deepEqual(signed.map(({ name, buyer_ref }) => ({ name, buyer_ref })), [{ name: 'Bo Buyer', buyer_ref: 'held:bo@example.com' }], 'a free deal goes to the account kept for the proved email');
  assert.match(await (await open('', { headers: { cookie } })).text(), /Signed by Bo Buyer/);
});

// A listed public link to a list (record-sharing.json addresses): the list page names every row at its own address,
// each row has its own indexed page with structured data, and /share/sitemap.xml and /share/llms.txt name them all.
test('a listed list link is a set of indexed pages, one per row, named in the sitemap and llms.txt', async () => {
  const copy = shareableCopy('list', 'list:compare', {
    label: 'Trillion compared', about: 'How Trillion compares, from each product\'s own pages.',
    fields: [{ id: 'title', label: 'Name', kind: 'text' }, { id: 'summary', label: 'In short', kind: 'long-text' }, { id: 'source', label: 'Their page', kind: 'link-address' }, { id: 'checked', label: 'Checked', kind: 'date', action: { secret: 'NOT SHARED' } }],
    rows: [
      { id: 'r1', title: 'Trillion vs Zapier', values: { title: 'Trillion vs Zapier', summary: 'Zapier runs triggers and actions across apps.', source: 'https://zapier.com/mcp', checked: '2026-10-04' } },
      { id: 'r2', title: 'Pay', values: { title: 'Pay', summary: 'A row whose name is one of a link\'s own parts.' } },
    ],
  });
  const person = withShareFileAccess({
    resolveRecordShare: async () => ({ ...copy, preview: previewOf(copy) }),
    listedShare: async name => ({ name, title: copy.title, changed: '2026-10-04', copy: { title: copy.title, body: copy.body } }),
  });
  const access = await person.shareAccess();
  person.shareAccess = async () => ({ ...access, listed: true, address: 'trillion-compared' });
  const values = new Map([['record-share-link:trillion-compared', JSON.stringify({ person_ref: 'owner', code: 'c'.repeat(48) })], ['record-share-listed:trillion-compared', '{}']]);
  const kv = { get: async (key, type) => (values.has(key) ? (type === 'json' ? JSON.parse(values.get(key)) : values.get(key)) : null), list: async ({ prefix }) => ({ keys: [...values.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })), list_complete: true }) };
  const env = { APP_KV: kv, PERSON: { idFromString: id => id, get: () => person } };
  const open = path => answerRecordShare(new Request(`https://app.gettrillion.ai${path}`), { env, kv, origin: 'https://app.gettrillion.ai' });

  const list = await open('/share/trillion-compared');
  assert.equal(list.status, 200);
  const listHtml = await list.text();
  assert.doesNotMatch(listHtml, /noindex/);
  assert.match(listHtml, /"@type":"CollectionPage"/);
  assert.match(listHtml, /href="\/share\/trillion-compared\/trillion-vs-zapier"/);
  assert.match(listHtml, /href="\/share\/trillion-compared\/pay-row"/);
  assert.doesNotMatch(listHtml, /NOT SHARED/);

  const row = await open('/share/trillion-compared/trillion-vs-zapier');
  assert.equal(row.status, 200);
  const rowHtml = await row.text();
  assert.match(rowHtml, /<h1[^>]*>Trillion vs Zapier<\/h1>/);
  assert.match(rowHtml, /"@type":"Article"/);
  assert.match(rowHtml, /href="https:\/\/zapier\.com\/mcp"/);
  assert.match(rowHtml, /rel="canonical" href="https:\/\/app\.gettrillion\.ai\/share\/trillion-compared\/trillion-vs-zapier"/);
  assert.equal((await open('/share/trillion-compared/no-such-row')).status, 404);

  const sitemap = await (await open('/share/sitemap.xml')).text();
  assert.match(sitemap, /<loc>https:\/\/app\.gettrillion\.ai\/share\/trillion-compared<\/loc><lastmod>2026-10-04<\/lastmod>/);
  assert.match(sitemap, /<loc>https:\/\/app\.gettrillion\.ai\/share\/trillion-compared\/trillion-vs-zapier<\/loc><lastmod>2026-10-04<\/lastmod>/);
  const llms = await (await open('/share/llms.txt')).text();
  assert.match(llms, /- \[Trillion vs Zapier\]\(https:\/\/app\.gettrillion\.ai\/share\/trillion-compared\/trillion-vs-zapier\): Zapier runs triggers/);

  // An unlisted link stays out of search results.
  person.shareAccess = async () => ({ ...access, listed: false });
  assert.match(await (await open('/share/trillion-compared')).text(), /noindex/);
});

// A saved view a list shows (src/list-copy.mjs shown_views) is a host element on the list page, whatever it is drawn as,
// and the page loads the share script and sheet that draw it; a list with none loads neither.
test('a shared list page holds one host per shown view and loads the script that draws it', async () => {
  const base = shareableCopy('list', 'list:sales', {
    label: 'Sales', fields: [{ id: 'title', label: 'Name', kind: 'text' }, { id: 'amount', label: 'Amount', kind: 'number' }],
    rows: [{ id: 'r1', title: 'North', values: { title: 'North', amount: 4 } }, { id: 'r2', title: 'South', values: { title: 'South', amount: 9 } }, { id: 'r3', title: 'Hidden', values: { title: 'Hidden', amount: 1 } }],
  });
  const shown = [
    { id: 'v1', label: 'Sales by region </script><b>', display: { as: 'chart', settings: { mark: 'bar', reading: 'amount' } }, row_ids: ['r1', 'r2'] },
    { id: 'v2', label: 'Plain', row_ids: ['r1'] },
  ];
  const pageFor = async copy => {
    const person = withShareFileAccess({ resolveRecordShare: async () => ({ ...copy, preview: previewOf(copy) }) });
    const code = 'v'.repeat(48);
    const env = { APP_KV: { get: async () => ({ person_ref: 'owner' }) }, PERSON: { idFromString: id => id, get: () => person } };
    return (await answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}`), { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai' })).text();
  };
  const imageIdentity = `1f:${'a'.repeat(64)}`;
  const videoIdentity = `1f:${'b'.repeat(64)}`;
  const posterIdentity = `1f:${'c'.repeat(64)}`;
  const html = await pageFor({ ...base, body: { ...base.body, shown_views: shown,
    files: [{ identity: imageIdentity, media_type: 'image/png', name: '/Pictures/shared.png' },
      { identity: videoIdentity, media_type: 'video/mp4', name: '/Recordings/private.mp4', poster_identity: posterIdentity, poster_media_type: 'image/png' }] } });
  assert.equal([...html.matchAll(/data-list-view="/g)].length, 1, 'only a view that says how it is drawn gets a host');
  assert.match(html, /data-list-view="chart"/);
  assert.match(html, /aria-label="Sales by region &lt;\/script&gt;&lt;b&gt;"/);
  assert.match(html, /<h2[^>]*>Sales by region &lt;\/script&gt;&lt;b&gt;<\/h2>/);
  assert.match(html, /\/workspace\/share-view\.js/);
  assert.match(html, /\/workspace\/share-view\.css/);
  const carried = html.match(/<script type="application\/json" class="page-view-data">([\s\S]*?)<\/script>/);
  assert.ok(carried, 'the view carries its data in one inert script');
  assert.doesNotMatch(carried[1], /</, 'nothing in the data can close its script');
  const data = JSON.parse(carried[1]);
  assert.deepEqual(data.settings, { mark: 'bar', reading: 'amount' });
  assert.deepEqual(data.fields.map(field => field.id), ['title', 'amount']);
  assert.deepEqual(data.rows.map(row => row.id), ['r1', 'r2'], 'the view carries only the rows it keeps');
  assert.deepEqual(data.rows[1].values, { title: 'South', amount: 9 });
  assert.deepEqual(data.files, [{ identity: imageIdentity, media_type: 'image/png', url: `/share/${'v'.repeat(48)}/files/${imageIdentity}` },
    { identity: videoIdentity, media_type: 'video/mp4', url: `/share/${'v'.repeat(48)}/files/${videoIdentity}`, poster_url: `/share/${'v'.repeat(48)}/files/${videoIdentity}/poster` }],
    'saved view media uses the same grant-checked share-file route and carries no private file name');
  assert.doesNotMatch(carried[1], /private\.mp4|shared\.png|poster_identity/);

  const bare = await pageFor(base);
  assert.doesNotMatch(bare, /data-list-view|page-view-data|share-view\.js|share-view\.css/);
});

test('a copied list poster reaches the original file grant and closes when the grant is withdrawn', async () => {
  const identity = `1f:${'b'.repeat(64)}`;
  const poster = `1f:${'c'.repeat(64)}`;
  const origin = 'https://app.gettrillion.ai';
  let admitted = true;
  const calls = [];
  const person = {
    async sharedFileForLink(_code, recipient, part) {
      calls.push({ identity: recipient.file_identity, part, access_code: recipient.access_code });
      if (!admitted || recipient.file_identity !== identity || recipient.access_code !== 'read this') return { denied: true };
      const copy = { kind: 'file', title: 'Clip', body: { identity, media_type: 'video/mp4', poster_identity: poster } };
      return { copy, row: part === 'poster' ? { identity: poster, byte_length: 6, media_type: 'image/png', origin: 'bucket', key: 'poster' } : null,
        owner_user_id: 'owner', attached_origin_ids: ['bucket'], attached_origins: [] };
    },
    namespaceAttachedOrigins() { throw new Error('The checked poster grant already supplied its origin admission.'); },
  };
  const kv = { get: async () => ({ person_ref: 'owner' }) };
  const env = { APP_KV: kv, PERSON: { idFromString: id => id, idFromName: id => id, get: () => person },
    NAMESPACE_ORIGINS: JSON.stringify([{ id: 'bucket', interface: 'object-bucket', binding: 'FILE_BUCKET' }]),
    FILE_BUCKET: { get: async () => ({ body: new TextEncoder().encode('poster') }) } };
  const answer = path => answerRecordShare(new Request(`${origin}/share/sales/files/${path}`), { env, kv, origin });
  const response = await answer(`${identity}/poster?access_code=read%20this`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'poster');
  assert.deepEqual(calls[0], { identity, part: 'poster', access_code: 'read this' }, 'the original copied file authorizes its derivative');
  assert.equal((await answer(`${poster}/poster?access_code=read%20this`)).status, 404, 'a raw poster identity is not an approved original file');
  assert.equal((await answer(`${identity}/poster`)).status, 404);
  admitted = false;
  assert.equal((await answer(`${identity}/poster?access_code=read%20this`)).status, 404);
});

// A shared list read as data (GET /share/<code>.json): any site or AI reads the fields and the rows shown now, each
// picture or video as the address that serves it through the same link, open to any origin; a refused link is refused.
test('a shared list reads as data with its rows and the files they name', async () => {
  const identity = `1f:${'d'.repeat(64)}`;
  const copy = shareableCopy('list', 'list:changelog', {
    label: 'Changelog', about: 'What changed.',
    fields: [{ id: 'title', label: 'Name', kind: 'text' }, { id: 'picture', label: 'Picture', kind: 'file', media: true }],
    rows: [{ id: 'r1', title: 'Lists share as pages', values: { title: 'Lists share as pages', picture: identity } }],
    files: [{ identity, media_type: 'image/png', name: '/Changelog/lists.png' }],
  });
  const person = withShareFileAccess({ resolveRecordShare: async () => ({ ...copy, preview: previewOf(copy) }) });
  const access = await person.shareAccess();
  let admitted = true;
  let requiredCode = null;
  const opens = [];
  person.sharedPageForLink = async (_code, recipient, { count_open }) => {
    opens.push(count_open);
    const allowed = admitted && (!requiredCode || recipient.access_code === requiredCode);
    return { access: { ...access, admitted: allowed, needs: allowed ? null : 'code', public: !requiredCode },
      copy: allowed ? { ...copy, preview: previewOf(copy) } : null };
  };
  const values = new Map([['record-share-link:changelog', JSON.stringify({ person_ref: 'owner', code: 'c'.repeat(48) })]]);
  const kv = { get: async (key, type) => (values.has(key) ? (type === 'json' ? JSON.parse(values.get(key)) : values.get(key)) : null) };
  const env = { APP_KV: kv, PERSON: { idFromString: id => id, get: () => person } };
  const answer = await answerRecordShare(new Request('https://app.gettrillion.ai/share/changelog.json'), { env, kv, origin: 'https://app.gettrillion.ai' });
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get('access-control-allow-origin'), '*');
  const data = await answer.json();
  assert.equal(data.title, 'Changelog');
  assert.equal(data.rows[0].values.picture, identity);
  assert.equal(data.rows[0].url, 'https://app.gettrillion.ai/share/changelog/lists-share-as-pages');
  assert.equal(data.files[0].url, `https://app.gettrillion.ai/share/changelog/files/${identity}`);
  assert.deepEqual(opens, [false], 'reading the data never counts as an open');
  requiredCode = 'secret';
  const open = path => answerRecordShare(new Request(`https://app.gettrillion.ai/share/changelog${path}`), { env, kv, origin: 'https://app.gettrillion.ai' });
  assert.equal((await open('.json')).status, 404);
  const coded = await (await open('.json?access_code=secret')).json();
  assert.equal(coded.rows[0].url, 'https://app.gettrillion.ai/share/changelog/lists-share-as-pages?access_code=secret');
  assert.equal(coded.files[0].url, `https://app.gettrillion.ai/share/changelog/files/${identity}?access_code=secret`);
  const listHtml = await (await open('?access_code=secret')).text();
  assert.match(listHtml, /href="\/share\/changelog\/lists-share-as-pages\?access_code=secret"/);
  const rowHtml = await (await open('/lists-share-as-pages?access_code=secret')).text();
  assert.match(rowHtml, new RegExp(`/share/changelog/files/${identity}\\?access_code=secret`));
  assert.match(rowHtml, /href="\/share\/changelog\?access_code=secret"/);
  assert.doesNotMatch(rowHtml, /rel="canonical"[^>]*access_code/);
  admitted = false;
  assert.equal((await answerRecordShare(new Request('https://app.gettrillion.ai/share/changelog.json'), { env, kv, origin: 'https://app.gettrillion.ai' })).status, 404);
});

test('a folder link takes files from someone with no account and never shows what the folder holds', async () => {
  const { folderOf, keptFileName } = await import('../src/record-sharing.mjs');
  assert.equal(folderOf('folder:/From clients/'), '/From clients');
  assert.equal(folderOf('folder:/a/../b'), null, 'a path that climbs out is refused');
  assert.equal(keptFileName('../../secrets/.env'), 'env', 'only the last part of a sent name is kept, never hidden');
  const code = 'f'.repeat(32);
  const origin = 'https://app.gettrillion.ai';
  let open = true;
  const added = [];
  const person = {
    async shareAccess() { return { admitted: open, needs: null, closed: !open, can: ['view', 'add_files'], acts_need_proof: false, proven: false, sender: 'Ana', look: { kind: 'trillion', name: 'Trillion' }, signatures: [], signed_by_you: false, paid: false }; },
    async resolveRecordShare() { return { kind: 'folder', title: 'From clients', body: { folder: '/From clients' } }; },
    async shareFolderForAdding(_code, _recipient, names) {
      if (!open) return { refused: 'This share link has ended.' };
      return { owner: 'user-ana', folder: '/From clients', names: names.map(name => `/From clients/${name === 'brief.pdf' ? 'brief (2).pdf' : name}`), sender: 'Ana' };
    },
    async noteFilesAddedThroughShare(_code, count) { added.push(count); },
  };
  const kept = [];
  const files = {
    keep: async (_env, owner, file) => { let bytes = 0; for await (const piece of await file.open()) bytes += piece.byteLength; kept.push({ owner, name: file.name, size: file.size, bytes, media_type: file.media_type }); },
    start: async (_env, owner, at, input) => Response.json({ state: 'growing', send_bytes_to: `${at}/namespace/growing/up:1/bytes?lease=x`, send_straight: { direct: 'd' }, owner, input }),
  };
  const env = { APP_KV: { get: async () => ({ person_ref: 'owner' }) }, PERSON: { idFromString: id => id, get: () => withShareFileAccess(person) } };
  const answer = request => answerRecordShare(request, { env, kv: env.APP_KV, origin, files });

  const shown = await (await answer(new Request(`${origin}/share/${code}`))).text();
  assert.match(shown, /<form class="page-choices" method="post" action="\/share\/f+\/add" enctype="multipart\/form-data">/);
  assert.match(shown, /type="file"[^>]*|multiple[^>]*type="file"/);
  assert.match(shown, /name="files"[^>]* multiple/);
  assert.doesNotMatch(shown, /brief\.pdf/, 'the page names nothing already in the folder');

  const form = new FormData();
  form.append('files', new File([new Uint8Array(5)], 'brief.pdf', { type: 'application/pdf' }));
  form.append('files', new File([new Uint8Array(3)], 'notes.txt', { type: 'text/plain' }));
  form.append('files', new File([], 'empty.txt'));
  const sent = await answer(new Request(`${origin}/share/${code}/add`, { method: 'POST', body: form, headers: { origin } }));
  assert.equal(sent.status, 200);
  assert.match(await sent.text(), /Sent 2 files\. Ana has them now\./);
  assert.deepEqual(kept, [
    { owner: 'user-ana', name: '/From clients/brief (2).pdf', size: 5, bytes: 5, media_type: 'application/pdf' },
    { owner: 'user-ana', name: '/From clients/notes.txt', size: 3, bytes: 3, media_type: 'text/plain' },
  ], 'each file is kept under the sharer, under a free name, with all its bytes');
  assert.deepEqual(added, [2]);

  const elsewhere = await answer(new Request(`${origin}/share/${code}/add`, { method: 'POST', body: new FormData(), headers: { origin: 'https://evil.example' } }));
  assert.equal(elsewhere.status, 403, 'a page on another site cannot send files through the link');

  const computer = await answer(new Request(`${origin}/share/${code}/add`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'cut.mov', byte_length: 5_000_000_000 }) }));
  assert.equal(computer.status, 200);
  const road = await computer.json();
  assert.equal(road.name, '/From clients/cut.mov');
  assert.match(road.send_bytes_to, /\/namespace\/growing\/up:1\/bytes\?lease=/);
  assert.deepEqual(road.send_straight, { direct: 'd' });

  open = false;
  const ended = await answer(new Request(`${origin}/share/${code}/add`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'late.txt', byte_length: 4 }) }));
  assert.equal(ended.status, 404, 'a closed link takes nothing');
});

test('a shared file of words opens as a page: its words drawn as markdown under its title, the file still to open', async () => {
  const code = 'w'.repeat(32);
  const identity = `1f:${'d'.repeat(64)}`;
  const words = '# Display it beautifully\n\n**User:** Anonymous  \n**Created:** 10/6/2026\n\n## Prompt:\n\nIs there a way?\n\n> **Showed the work map**\n>\n> Worked for 3m 9s\n\n| Part | Shown |\n|---|---:|\n| Table | 2 |\n\n<script>alert(1)</script>';
  const bytes = new TextEncoder().encode(words);
  const person = {
    resolveRecordShare: async () => ({ kind: 'file', title: 'Display it beautifully.md', body: { identity, name: '/Pages/Display it beautifully.md', byte_length: bytes.length, media_type: 'text/plain' } }),
    namespaceLocate: async asked => asked === identity ? { identity, byte_length: bytes.length, media_type: 'text/plain', origin: 'bucket', key: 'words-file', names: ['/Pages/Display it beautifully.md'] } : null,
    ownerUserId: async () => 'owner-account',
    namespaceAttachedOrigins: async () => [],
  };
  const env = {
    APP_KV: { get: async key => key === `${RECORD_SHARE_LINK_INDEX}${code}` ? { person_ref: 'durable-object-id' } : null },
    PERSON: { idFromString: id => id, idFromName: name => name, get: () => withShareFileAccess(person) },
    NAMESPACE_ORIGINS: JSON.stringify([{ id: 'bucket', interface: 'object-bucket', binding: 'FILE_BUCKET' }]),
    FILE_BUCKET: { get: async (key, { range }) => ({ body: bytes.slice(range.offset, range.offset + range.length) }) },
  };
  const response = await answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}`), { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai' });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /<title>Display it beautifully<\/title>/, 'the page is titled by the file name without its ending');
  assert.match(html, /<h1 class="page-heading">Display it beautifully<\/h1><div class="page-prose">/);
  assert.doesNotMatch(html, /id="display-it-beautifully"/, 'a first heading that repeats the title is not drawn twice');
  assert.match(html, /<strong>User:<\/strong> Anonymous<br><strong>Created:<\/strong>/, 'a line ending in two spaces breaks');
  assert.match(html, /<h2 class="doc-h2" id="prompt">Prompt:<\/h2>/);
  assert.match(html, /<blockquote class="doc-quote doc-quote--held"><p class="doc-p"><strong>Showed the work map<\/strong><\/p><p class="doc-p">Worked for 3m 9s<\/p><\/blockquote>/);
  assert.match(html, /<table class="doc-table"><thead><tr><th>Part<\/th><th data-align="right">Shown<\/th>/);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !html.includes('<script>alert(1)'), 'raw HTML in the words is shown as text');
  assert.match(html, /class="page-prose"/);
  assert.match(html, /\.page-prose \.doc-table/, 'the prose look comes with the page');
  assert.match(html, /href="\/share\/w{32}\/file"[^>]*>Open file/);
  assert.match(html, /href="\/share\/w{32}\/file\?download=1"[^>]*>Download/);
});

test('a focused file of words in a mixed collection reads only its indexed file through the current grant', async () => {
  const code = 't'.repeat(48);
  const identity = `1f:${'9'.repeat(64)}`;
  const text = 'The focused file is readable.\nNo separate link is needed.\n<script>inert</script>';
  const bytes = new TextEncoder().encode(text);
  const items = Array.from({ length: 35 }, (_, index) => index === 17
    ? { kind: 'file', title: 'readme.txt', body: { identity, name: '/Notes/readme.txt', byte_length: bytes.length, media_type: 'text/plain' } }
    : { kind: 'text', title: `Note ${index}`, body: { text: `Text ${index}` } });
  let byteReads = 0;
  let stale = false;
  const indexedReads = [];
  const row = { identity, byte_length: bytes.length, media_type: 'text/plain', origin: 'bucket', key: 'readme', names: ['/Notes/readme.txt'] };
  const person = withShareFileAccess({
    async resolveRecordShare(_code, recipient) {
      if (recipient.item_index !== undefined) return items[recipient.item_index] ?? null;
      const offset = recipient.item_offset ?? 0;
      return { kind: 'collection', title: '35 mixed items', item_offset: offset, item_count: items.length,
        has_more: offset + (recipient.item_limit ?? 12) < items.length, items: items.slice(offset, offset + (recipient.item_limit ?? 12)) };
    },
    async sharedFileForLink(_code, recipient) {
      indexedReads.push(recipient.item_index);
      const copy = items[recipient.item_index];
      return { copy: stale ? { ...copy, body: { ...copy.body, identity: 'changed-file' } } : copy, row, owner_user_id: 'owner-account' };
    },
    namespaceAttachedOrigins: async () => [],
  });
  const env = {
    APP_KV: { get: async () => ({ person_ref: 'owner-store' }) },
    PERSON: { idFromString: id => id, idFromName: id => id, get: () => person },
    NAMESPACE_ORIGINS: JSON.stringify([{ id: 'bucket', interface: 'object-bucket', binding: 'FILE_BUCKET' }]),
    FILE_BUCKET: { get: async (_key, { range }) => { byteReads++; return { body: bytes.slice(range.offset, range.offset + range.length) }; } },
  };
  const answer = (path, init) => answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}${path}`, init),
    { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai' });
  const overview = await (await answer('?offset=12')).text();
  assert.match(overview, /readme\.txt/);
  assert.match(overview, /page-card-cover-text">Text 12<\/p>/, 'shared note words are visible in the gallery cover');
  assert.equal([...overview.matchAll(/class="page-card-cover-text"/g)].length, 11, 'every note in this page uses its own words');
  assert.doesNotMatch(overview, /page-card-cover-glyph[^>]*>¶<\/span>/, 'notes no longer share the same giant glyph');
  assert.doesNotMatch(overview, /The focused file is readable/);
  assert.deepEqual(indexedReads, [], 'a collection overview reads no file bytes');
  assert.equal(byteReads, 0);
  assert.equal((await answer('?item=17', { method: 'HEAD' })).status, 200);
  assert.deepEqual(indexedReads, [], 'HEAD never reads words that it cannot return');
  const focused = await (await answer('?item=17')).text();
  assert.match(focused, /The focused file is readable/);
  assert.match(focused, /No separate link is needed/);
  assert.match(focused, /&lt;script&gt;inert&lt;\/script&gt;/);
  assert.doesNotMatch(focused, /<script>inert<\/script>/);
  assert.deepEqual(indexedReads, [17], 'the file grant uses the absolute collection index');
  assert.equal(byteReads, 1);
  stale = true;
  const changed = await (await answer('?item=17')).text();
  assert.doesNotMatch(changed, /The focused file is readable/, 'a changed indexed file never appears under an old title');
  assert.deepEqual(indexedReads, [17, 17]);
  assert.equal(byteReads, 1, 'a stale source is rejected before bytes are read');
});

test('a long shared file of words draws its first part, ends at a whole line and says the rest is in the file', async () => {
  const code = 'v'.repeat(32);
  const identity = `1f:${'e'.repeat(64)}`;
  const line = 'A line of words that repeats.\n';
  const text = line.repeat(Math.ceil((sharing.reading.most_bytes + 5000) / line.length));
  const bytes = new TextEncoder().encode(text);
  const person = {
    resolveRecordShare: async () => ({ kind: 'file', title: 'notes.txt', body: { identity, name: '/notes.txt', byte_length: bytes.length, media_type: 'text/plain' } }),
    namespaceLocate: async asked => asked === identity ? { identity, byte_length: bytes.length, media_type: 'text/plain', origin: 'bucket', key: 'long', names: ['/notes.txt'] } : null,
    ownerUserId: async () => 'owner-account',
    namespaceAttachedOrigins: async () => [],
  };
  let asked = null;
  const env = {
    APP_KV: { get: async key => key === `${RECORD_SHARE_LINK_INDEX}${code}` ? { person_ref: 'durable-object-id' } : null },
    PERSON: { idFromString: id => id, idFromName: name => name, get: () => withShareFileAccess(person) },
    NAMESPACE_ORIGINS: JSON.stringify([{ id: 'bucket', interface: 'object-bucket', binding: 'FILE_BUCKET' }]),
    FILE_BUCKET: { get: async (key, { range }) => { asked = range; return { body: bytes.slice(range.offset, range.offset + range.length) }; } },
  };
  const html = await (await answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}`), { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai' })).text();
  assert.equal(asked.offset + asked.length, sharing.reading.most_bytes, 'only the first part of the file is read');
  assert.match(html, /<h1 class="page-heading">notes<\/h1>/);
  assert.ok(html.includes(`<em>${sharing.reading.more}</em>`));
  assert.ok(html.includes('A line of words that repeats.<br>'), 'plain words keep their line breaks');
});

test('a file that is not words keeps its own section, with no words read', async () => {
  const code = 'u'.repeat(32);
  let read = false;
  const person = withShareFileAccess({
    resolveRecordShare: async () => ({ kind: 'file', title: 'clip.mp4', body: { identity: `1f:${'f'.repeat(64)}`, byte_length: 10, media_type: 'video/mp4' } }),
    namespaceLocate: async () => { read = true; return null; },
  });
  const env = { APP_KV: { get: async () => ({ person_ref: 'owner' }) }, PERSON: { idFromString: id => id, get: () => person } };
  const html = await (await answerRecordShare(new Request(`https://app.gettrillion.ai/share/${code}`), { env, kv: env.APP_KV, origin: 'https://app.gettrillion.ai' })).text();
  assert.equal(read, false);
  assert.doesNotMatch(html, /class="page-prose"/);
  assert.match(html, />Download</);
});

test('comparison evidence rows stay out of sitemap and llms listings', async () => {
  const copy = { title: 'Compared', body: { about: 'Choices', fields: [
    { id: 'title', kind: 'text' }, { id: 'record_kind', kind: 'choice' }],
    public_page: { layout: 'comparison', evidence_rows: { kind_field: 'record_kind', comparison_kind: 'comparison' } },
    rows: [
      { id: 'comparison', title: 'Trillion vs Paper', values: { title: 'Trillion vs Paper', record_kind: 'comparison' } },
      { id: 'source', title: 'Paper source', values: { title: 'Paper source', record_kind: 'source' } },
    ] } };
  const person = { listedShare: async name => ({ name, title: copy.title, changed: '2026-10-07', copy }) };
  const values = new Map([['record-share-link:compared', JSON.stringify({ person_ref: 'owner' })], ['record-share-listed:compared', '{}']]);
  const kv = { get: async (key, type) => type === 'json' ? JSON.parse(values.get(key) ?? 'null') : values.get(key) ?? null,
    list: async ({ prefix }) => ({ keys: [...values.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })), list_complete: true }) };
  const env = { APP_KV: kv, PERSON: { idFromString: id => id, get: () => person } };
  const open = path => answerRecordShare(new Request(`https://app.gettrillion.ai${path}`), { env, kv, origin: 'https://app.gettrillion.ai' });
  const sitemap = await (await open('/share/sitemap.xml')).text();
  const llms = await (await open('/share/llms.txt')).text();
  assert.match(sitemap, /trillion-vs-paper/);
  assert.doesNotMatch(sitemap, /paper-source/);
  assert.match(llms, /trillion-vs-paper/);
  assert.doesNotMatch(llms, /paper-source/);
});

test('a chart on a share page reads the page look\'s own foreground, muted, card and line colours, and the share script marks the look\'s scheme', () => {
  // The look's text colour reaches the chart through the page's roles, so a dark look draws white chart ink, not the light-page fallback.
  const host = PAGE_SECTIONS_CSS.match(/\.page-view\{[^}]*\}/)?.[0] ?? '';
  for (const [role, page] of [['--color-foreground', '--page-ink'], ['--color-muted-foreground', '--page-soft'], ['--color-card', '--page-card'], ['--color-border', '--page-line']]) {
    assert.ok(host.includes(`${role}:var(${page})`), `${role} follows ${page} on the view host`);
  }
  // The scheme is read from the look's ground, the same way the app reads it.
  assert.equal(screenLookScheme({ '--bg-primary': '#000000' }, '--bg-primary'), 'dark');
  assert.equal(screenLookScheme({ '--bg-primary': '#fffdf8' }, '--bg-primary'), 'light');
  assert.equal(screenLookScheme({ '--bg-primary': '' }, '--bg-primary'), null);
  const island = readFileSync(new URL('../src/workspace/share-view.tsx', import.meta.url), 'utf8');
  assert.match(island, /screenLookScheme\(/);
  assert.match(island, /dataset\.lookScheme/);
});

const ORIGIN = 'https://app.gettrillion.ai';

test('an unmounted share fails closed without invoking the old account owner', async () => {
  let fallback = 0;
  const kv = { get: async () => ({ person_ref: 'saved-owner' }) };
  const env = { APP_KV: kv, PERSON: { get() { fallback++; throw new Error('Old account dispatch is forbidden'); }, idFromString: value => value } };
  const response = await answerNativeRecordShare(new Request(ORIGIN + '/share/current-share.json'), { env, kv, origin: ORIGIN });
  assert.equal(response.status, 503);
  assert.equal(fallback, 0);
});

test('mixed collection selection passes the exact item window through its installed grant owner', async () => {
  const observed = [];
  const kv = { get: async () => ({ person_ref: 'saved-owner', record: 'share-bundle:original' }) };
  const env = { APP_KV: kv, PERSON: { get() { throw new Error('Old account dispatch is forbidden'); } } };
  const owner = { async sharedPageForLink(code, recipient, options) {
    observed.push({ code, recipient, options });
    return { access: { admitted: true, public: true, can: {} }, copy: { kind: 'collection', title: 'Mixed', item_count: 100, item_offset: options.item_offset, items: [
      { kind: 'workflow', title: 'Original workflow', body: { steps: [] } },
      { kind: 'file', title: 'Original recording', body: { identity: '1f:' + 'a'.repeat(64), name: '/Original recording.mp4', media_type: 'video/mp4' } },
      { kind: 'text', title: 'Original notes', body: { text: 'Original text' } },
    ], has_more: true } };
  } };
  const response = await answerNativeRecordShare(new Request(ORIGIN + '/share/current-share.json?offset=24&access_code=exact-code'), { env, kv, origin: ORIGIN,
    session: { verified_email: 'recipient@example.test', relay: 'verified-recipient' },
    shareOwnerFor: async ({ index, code, recipient }) => { assert.equal(index.record, 'share-bundle:original'); assert.equal(code, 'current-share'); assert.equal(recipient.relay, 'verified-recipient'); return owner; } });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.total_items, 100);
  assert.equal(data.offset, 24);
  assert.deepEqual(data.items.map(item => [item.index, item.kind]), [[24, 'workflow'], [25, 'file'], [26, 'text']]);
  assert.equal(data.items[1].file_url, ORIGIN + '/share/current-share/items/25/file?access_code=exact-code');
  assert.equal(observed.length, 1);
  assert.equal(observed[0].options.item_offset, 24);
  assert.equal(observed[0].options.count_open, false);
  assert.equal(observed[0].recipient.access_code, 'exact-code');
  assert.equal(observed[0].recipient.verified_email, 'recipient@example.test');
});

test('the default public consumer resolves the actual indexed native grant address without account dispatch', async () => {
  const index = { person_ref: 'current-owner', work_resource: 'work:current-share', supply: 'own-record-resource' };
  const observed = [];
  const kv = { get: async () => index };
  const env = { APP_KV: kv, PERSON: { get() { throw new Error('Old account dispatch is forbidden'); } },
    RECORD_BOOK: { idFromName: value => value, get: address => ({ async readOwnResourceShare(owner, resource, input) {
      observed.push({ address, owner, resource, input });
      return { access: { admitted: true, public: true, can: ['view'] },
        copy: { kind: 'collection', title: 'Mixed', item_offset: 0, item_count: 1, items: [{ kind: 'text', title: 'A note', body: { text: 'Current words' } }] } };
    } }) } };
  const response = await answerNativeRecordShare(new Request(ORIGIN + '/share/current-share.json'), { env, kv, origin: ORIGIN,
    session: { relay: 'verified-recipient', verified_email: 'recipient@example.test' } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).items[0].title, 'A note');
  assert.equal(observed.length, 1);
  assert.equal(observed[0].address, 'own-record-resource:["current-owner","work:current-share"]');
  assert.equal(observed[0].owner, 'current-owner');
  assert.equal(observed[0].resource, 'work:current-share');
  assert.equal(observed[0].input.method, 'sharedPageForLink');
  assert.equal(observed[0].input.recipient.relay, 'verified-recipient');
  assert.equal(observed[0].input.args[0].count_open, false);
});

test('a selected recording transcript passes its item and original identity and reveals only kept words', async () => {
  const identity = '1f:' + 'd'.repeat(64);
  const kv = { get: async () => ({ person_ref: 'current-owner' }) };
  const observed = [];
  const owner = {
    async sharedFileForLink(_code, asking, part) {
      assert.equal(asking.item_index, 25);
      assert.equal(part, 'transcript');
      return { copy: { kind: 'file', body: { identity } }, row: { identity } };
    },
    async readSharedTranscript(input) {
      observed.push(input);
      return { text: 'Kept words', segments: [{ start: 0, end: 1, text: 'Kept words' }], aliases: ['private-alias'], maker: 'private-maker' };
    },
  };
  const response = await answerNativeRecordShare(new Request(ORIGIN + '/share/current-share/items/25/transcript'), {
    env: {}, kv, origin: ORIGIN, shareOwnerFor: async () => owner });
  assert.equal(response.status, 200);
  assert.deepEqual(observed, [{ identity, item_index: 25 }]);
  assert.deepEqual(await response.json(), { text: 'Kept words', segments: [{ start: 0, end: 1, text: 'Kept words' }] });
});

test('shared bytes use the freshly supplied access and forward the exact selected item', async () => {
  const identity = '1f:' + 'e'.repeat(64);
  const kv = { get: async () => ({ person_ref: 'current-owner' }) };
  const stale = { copy: { kind: 'file', body: { identity } }, row: { identity, growing: true } };
  const owner = {
    sharedFileForLink: async () => stale,
    async withSharedNamespace(input, use) {
      assert.equal(input.item_index, 7);
      assert.equal(input.access, stale, 'the preceding read is only a request to revalidate');
      return use({ env: {}, namespace: {}, access: { copy: { kind: 'file', body: { identity } },
        row: { identity, byte_length: 0, names: ['/Current clip.mp4'], media_type: 'video/mp4' }, owner_user_id: 'current-owner' } });
    },
  };
  const response = await answerNativeRecordShare(new Request(ORIGIN + '/share/current-share/items/7/file'), {
    env: {}, kv, origin: ORIGIN, shareOwnerFor: async () => owner });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), '0');
  assert.equal(response.headers.get('content-type'), 'video/mp4');
});

test('the native response carrier keeps bounded preview ranges and hides private storage headers', async () => {
  const identity = '1f:' + 'f'.repeat(64);
  const kv = { get: async () => ({ person_ref: 'current-owner' }) };
  const access = { copy: { kind: 'file', title: 'Shared clip', body: { identity, name: '/Chosen clip.mp4', preview_identity: identity } },
    row: { identity, byte_length: 4, media_type: 'video/mp4', names: ['/Private alternate name.mp4'] } };
  const owner = {
    sharedFileForLink: async () => access,
    async readSharedBytes(request, selectedAccess) {
      assert.equal(selectedAccess._native_selection.item_index, 4);
      assert.equal(request.headers.get('range'), `bytes=0-${HOT_PREFIX_BYTES - 1}`);
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 206, headers: {
        'content-type': 'video/mp4', 'content-length': '4', 'content-range': 'bytes 0-3/4',
        'content-disposition': 'inline; filename="Private alternate name.mp4"', 'x-storage-owner': 'private-owner',
      } });
    },
  };
  const response = await answerNativeRecordShare(new Request(ORIGIN + '/share/current-share/items/4/preview', { headers: { range: 'bytes=0-' } }), {
    env: {}, kv, origin: ORIGIN, shareOwnerFor: async () => owner });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 0-3/4');
  assert.equal(response.headers.get('x-storage-owner'), null);
  assert.match(response.headers.get('content-disposition'), /Chosen%20clip\.mp4/);
  assert.doesNotMatch(response.headers.get('content-disposition'), /Private/);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3, 4]);
});

test('an oversized gallery cover never opens the native original byte carrier', async () => {
  const identity = '1f:' + '1'.repeat(64);
  const kv = { get: async () => ({ person_ref: 'current-owner' }) };
  let opened = false;
  const owner = {
    sharedFileForLink: async () => ({ copy: { kind: 'file', body: { identity } }, row: {
      identity, byte_length: 10_000_000, media_type: 'image/jpeg', names: ['/Large photo.jpg'],
    } }),
    readSharedBytes: async () => { opened = true; throw new Error('A gallery must not download this original'); },
  };
  const response = await answerNativeRecordShare(new Request(ORIGIN + '/share/current-share/cover'), {
    env: {}, kv, origin: ORIGIN, shareOwnerFor: async () => owner });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-cover-source'), 'kind-glyph');
  assert.equal(opened, false);
  assert.equal(response.headers.get('content-type'), 'image/png');
});

test('the direct native small cover deletes an incoming range and keeps only public response fields', async () => {
  const identity = '1f:' + '2'.repeat(64);
  const kv = { get: async () => ({ person_ref: 'current-owner' }) };
  const owner = {
    sharedFileForLink: async () => ({ copy: { kind: 'file', title: 'Chosen picture', body: { identity } }, row: {
      identity, byte_length: 3, media_type: 'image/png', names: ['/Chosen picture.png'],
    } }),
    async readSharedBytes(request) {
      assert.equal(request.headers.get('range'), null);
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png', 'content-length': '3',
        'x-storage-owner': 'private-owner', 'set-cookie': 'private-source-cookie', 'content-disposition': 'inline; filename="private-storage-name"' } });
    },
  };
  const response = await answerNativeRecordShare(new Request(ORIGIN + '/share/current-share/cover', { headers: { range: 'bytes=1-2' } }), {
    env: {}, kv, origin: ORIGIN, shareOwnerFor: async () => owner });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), '3');
  assert.equal(response.headers.get('x-trillion-expected-bytes'), '3');
  assert.equal(response.headers.get('x-storage-owner'), null);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('content-disposition'), "inline; filename*=UTF-8''Chosen%20picture");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
});

test('the direct native response cancels a pending body as soon as the recipient leaves', async () => {
  const identity = '1f:' + '3'.repeat(64);
  const kv = { get: async () => ({ person_ref: 'current-owner' }) };
  let cancelled = false, requested;
  const waiting = new Promise(resolve => { requested = resolve; });
  const owner = {
    sharedFileForLink: async () => ({ copy: { kind: 'file', body: { identity } }, row: { identity, byte_length: 3, media_type: 'application/octet-stream' } }),
    readSharedBytes: async () => new Response(new ReadableStream({ pull() { requested(); }, cancel() { cancelled = true; } }, { highWaterMark: 0 })),
  };
  const caller = new AbortController();
  const response = await answerNativeRecordShare(new Request(ORIGIN + '/share/current-share/file', { signal: caller.signal }), {
    env: {}, kv, origin: ORIGIN, shareOwnerFor: async () => owner });
  const reading = response.arrayBuffer();
  await waiting;
  caller.abort(new DOMException('The recipient left', 'AbortError'));
  await assert.rejects(reading, /recipient left|aborted/i);
  assert.equal(cancelled, true);
});

test('a folder upload uses and reports the current collision-free name supplied by its grant owner', async () => {
  const kv = { get: async () => ({ person_ref: 'current-owner' }) };
  const stale = { owner: 'stale-owner', names: ['/Old name.mov'] };
  const owner = {
    shareFolderForAdding: async () => stale,
    withSharedNamespace: async (input, use) => {
      assert.equal(input.operation, 'add-files');
      assert.equal(input.target, stale);
      return use({ env: { current: true }, target: { owner: 'current-owner', names: ['/Current folder/clip (2).mov'] } });
    },
    noteFilesAddedThroughShare: async () => null,
  };
  const observed = [];
  const response = await answerNativeRecordShare(new Request(ORIGIN + '/share/current-share/add', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'clip.mov', byte_length: 20 }),
  }), { env: {}, kv, origin: ORIGIN, shareOwnerFor: async () => owner, files: {
    async start(env, user, _origin, input) {
      observed.push({ env, user, input });
      return Response.json({ state: 'present' });
    },
  } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).name, '/Current folder/clip (2).mov');
  assert.equal(observed[0].user, 'current-owner');
  assert.equal(observed[0].input.name, '/Current folder/clip (2).mov');
  assert.equal(observed[0].env.current, true);
});
