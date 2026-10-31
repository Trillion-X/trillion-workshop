// tools/paid-access/test/private-object-delivery.test.ts
//
// Gauntlet for the private-object delivery brain: mint (request) + authorize. Covers the full fail-closed matrix, the
// auth-decoupling attack (the object's gate is the OBJECT's property, never the caller's), live revocation, subject
// binding, and the mint→authorize round-trip.
//
// Ported from bitfield-packages packages/material-delivery do-work/private-object-delivery.test.ts (16 cases, 16
// here). Changed: the package mocked the old engine's target bus (a browser-session send for the subject, a
// product-access send for access, an engine read for the object map). Those are plain input now: the subject the
// door verified, a stand-in for "what does this account hold now?" (who-holds-access.mjs in the rows), and the person's
// `paid-file` records behind a stand-in records door. Each case keeps its old name and what it proves; three are
// restated in the new terms (an unreadable access answer, a refund, a session without authority). Every id here is
// made up.
import { beforeEach } from 'node:test';
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { requestPrivateObject } from '../read-data/request-private-object.ts';
import { authorizePrivateObject } from '../read-data/authorize-private-object.ts';
import { encodeDeliveryToken, decodeDeliveryToken } from '../read-data/delivery-token.ts';

const NOW_MS = 1_700_000_000_000;
const COURSE_KEY = 'chapter-one.pdf';
const COURSE_REF = 'access:course-a';

const PAID_FILES: Record<string, unknown> = {
  [COURSE_KEY]: {
    object_key: COURSE_KEY,
    object_store_ref: 'object-store:paid-files',
    cas_hash: '1f:' + 'c'.repeat(64),
    enc_key_ref: 'paid-files-key',
    enc_nonce: 'iv-course',
    enc_alg: 'aes-256-ctr',
    required_access_refs: [COURSE_REF],
    mime: 'application/pdf',
    ttl_seconds: 1800,
  },
  // an object whose bytes are not sealed yet (no cas_hash) → unavailable
  'pending-asset.mp3': {
    object_key: 'pending-asset.mp3',
    object_store_ref: 'object-store:paid-files',
    cas_hash: '',
    required_access_refs: [COURSE_REF],
    mime: 'audio/mpeg',
  },
};

// account -> held access refs now (as who-holds-access answers them); an account missing here cannot be worked out
let HELD: Record<string, string[]> = {};
let RECORDS_READABLE = true;

const door = {
  async read(type: string, id: string) {
    if (!RECORDS_READABLE) throw new Error('the records cannot be reached');
    return type === 'paid-file' ? PAID_FILES[id] ?? null : null;
  },
};
const run = { door, nowMs: NOW_MS, holds: async (subject: string) => HELD[subject] ?? null };
const asBuyer = (subject: string, extra: Record<string, unknown> = {}) => ({ subject, ...extra });

beforeEach(() => {
  HELD = { 'account-buyer': [COURSE_REF], 'account-free': ['access:public'] };
  RECORDS_READABLE = true;
});

// ---- request (mint) -------------------------------------------------------
describe('requestPrivateObject — fail-closed mint', () => {
  it('reports access that cannot be worked out without inventing a purchase denial', async () => {
    expect(await requestPrivateObject({ subject: 'account-nobody', object_key: COURSE_KEY }, run))
      .toEqual({ status: 'unavailable', reason: 'authorization-unavailable' });
  });
  it('a purchase followed by a refund denies delivery (the refund leaves the held refs without it)', async () => {
    HELD['account-buyer'] = [];
    expect(await requestPrivateObject(asBuyer('account-buyer', { object_key: COURSE_KEY }), run))
      .toEqual({ status: 'denied', reason: 'not-entitled' });
  });

  it('rejects a request without a verified subject even when it holds the access', async () => {
    expect(await requestPrivateObject({ subject: '', object_key: COURSE_KEY }, run))
      .toEqual({ status: 'denied', reason: 'anonymous' });
  });
  it('entitled buyer → grant with a delivery url, expiry, and mime', async () => {
    const r = await requestPrivateObject(asBuyer('account-buyer', { object_key: COURSE_KEY }), run);
    expect(r.status).toBe('grant');
    if (r.status !== 'grant') return;
    expect(r.delivery_url.startsWith('/private-material/')).toBe(true);
    expect(r.mime).toBe('application/pdf');
    expect(r.expires_at).toBe(NOW_MS / 1000 + 1800);
    // the token in the url decodes back to the object key (opaque reference, no bytes)
    const token = decodeDeliveryToken(r.delivery_url.split('/').pop()!);
    expect(token?.object_key).toBe(COURSE_KEY);
  });

  it('anonymous (no subject) → denied: anonymous', async () => {
    const r = await requestPrivateObject(asBuyer('', { object_key: COURSE_KEY }), run);
    expect(r).toEqual({ status: 'denied', reason: 'anonymous' });
  });

  it('signed-in but not entitled → denied: not-entitled', async () => {
    const r = await requestPrivateObject(asBuyer('account-free', { object_key: COURSE_KEY }), run);
    expect(r).toEqual({ status: 'denied', reason: 'not-entitled' });
  });

  it('AUTH-DECOUPLING ATTACK: a free buyer naming the paid key cannot borrow a free gate', async () => {
    // The file's required refs come from the OBJECT record, never the caller. A free account holding only public
    // access is denied even though it named the exact object_key and sent its own gate along.
    HELD['account-free'] = ['access:public', 'access:some-free-thing'];
    const r = await requestPrivateObject(asBuyer('account-free', { object_key: COURSE_KEY, required_access_refs: ['access:public'] }) as never, run);
    expect(r).toEqual({ status: 'denied', reason: 'not-entitled' });
  });

  it('object with no sealed bytes → unavailable: no-bytes', async () => {
    const r = await requestPrivateObject(asBuyer('account-buyer', { object_key: 'pending-asset.mp3' }), run);
    expect(r).toEqual({ status: 'unavailable', reason: 'no-bytes' });
  });

  it('object not in the records → unavailable: governing-item-missing', async () => {
    const r = await requestPrivateObject(asBuyer('account-buyer', { object_key: 'unknown.key' }), run);
    expect(r).toEqual({ status: 'unavailable', reason: 'governing-item-missing' });
  });

  it('records not readable → loading (never a false grant)', async () => {
    RECORDS_READABLE = false;
    const r = await requestPrivateObject(asBuyer('account-buyer', { object_key: COURSE_KEY }), run);
    expect(r).toEqual({ status: 'loading' });
  });
});

// ---- authorize (the real byte-boundary gate) ------------------------------
describe('authorizePrivateObject — live re-check at the byte boundary', () => {
  async function mintTokenFor(subject: string, key = COURSE_KEY) {
    const r = await requestPrivateObject(asBuyer(subject, { object_key: key }), run);
    if (r.status !== 'grant') throw new Error(`expected grant, got ${r.status}`);
    return r.delivery_url.split('/').pop()!;
  }

  it('entitled presenter + valid token → authorized with hash + how it is sealed, and the key only by name', async () => {
    const token = await mintTokenFor('account-buyer');
    const a = await authorizePrivateObject(asBuyer('account-buyer', { token }), run);
    expect(a.authorized).toBe(true);
    if (!a.authorized) return;
    expect(a.cas_hash).toBe('1f:' + 'c'.repeat(64));
    expect(a.enc_key_ref).toBe('paid-files-key');
    expect(a.enc_nonce).toBe('iv-course');
    expect(a.enc_alg).toBe('aes-256-ctr');
    expect(a.mime).toBe('application/pdf');
    expect(a).not.toHaveProperty('decrypt_key');
  });

  it('malformed token → not authorized', async () => {
    expect(await authorizePrivateObject(asBuyer('account-buyer', { token: 'not-hex!!' }), run)).toEqual({ authorized: false });
    expect(await authorizePrivateObject(asBuyer('account-buyer', { token: '' }), run)).toEqual({ authorized: false });
  });

  it('expired token → not authorized without even asking for the access', async () => {
    const stale = encodeDeliveryToken({ object_key: COURSE_KEY, issued_at: 1, expires_at: 2 });
    let read = 0;
    const counting = { door: { read: async (type: string, id: string) => { read += 1; return door.read(type, id); } }, nowMs: NOW_MS };
    const a = await authorizePrivateObject(asBuyer('account-buyer', { token: stale }), counting);
    expect(a).toEqual({ authorized: false });
    expect(read).toBe(0);
  });

  it('a leaked URL replayed by a DIFFERENT account that lacks the access → denied', async () => {
    const token = await mintTokenFor('account-buyer');
    const a = await authorizePrivateObject(asBuyer('account-free', { token }), run);
    expect(a).toEqual({ authorized: false });
  });

  it('live revocation: a once-entitled account is denied the next open after access removal', async () => {
    const token = await mintTokenFor('account-buyer');
    // access ended between mint and the next stream-open
    HELD['account-buyer'] = [];
    const a = await authorizePrivateObject(asBuyer('account-buyer', { token }), run);
    expect(a).toEqual({ authorized: false });
  });

  it('anonymous presenter → not authorized', async () => {
    const token = await mintTokenFor('account-buyer');
    const a = await authorizePrivateObject(asBuyer('', { token }), run);
    expect(a).toEqual({ authorized: false });
  });
});
