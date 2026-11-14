// The first version of this asked the provider to CREATE the certificate every
// time, and the second run failed with "Hostname already exists on app". That
// is the state a person is most likely to be in when they run it again, which
// is checking on something that already works. Its header claimed asking twice
// was safe; the claim was written before it was true.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  askTheHostProviderForACertificate,
  whatTheDomainStillNeeds,
  certificateRequest,
  certificateReadRequest,
} from '../processes/ask-the-host-provider-for-a-certificate.mjs';

const READY = {
  configured: true,
  acmeDnsConfigured: false,
  acmeAlpnConfigured: true,
  hostname: 'app.example.com',
  clientStatus: 'Ready',
};

/** A provider that answers reads with `existing` and records what it was sent. */
function providerWhere(existing) {
  const sent = [];
  const fetchImplementation = async (_url, options) => {
    const body = JSON.parse(options.body);
    sent.push(body.query.includes('mutation') ? 'create' : 'read');
    return {
      json: async () => (body.query.includes('mutation')
        ? { data: { addCertificate: { certificate: READY } } }
        : { data: { app: { certificate: existing } } }),
    };
  };
  return { sent, fetchImplementation };
}

test('a hostname the app already answers for is read, never created again', async () => {
  const { sent, fetchImplementation } = providerWhere(READY);
  const result = await askTheHostProviderForACertificate({
    application: 'example', hostname: 'app.example.com', applicationHost: 'example.fly.dev',
    credential: 'test-token', fetchImplementation,
  });
  assert.deepEqual(sent, ['read']);
  assert.equal(result.working, true);
});

test('a hostname the app does not have yet is created after the read finds none', async () => {
  const { sent, fetchImplementation } = providerWhere(null);
  const result = await askTheHostProviderForACertificate({
    application: 'example', hostname: 'app.example.com', applicationHost: 'example.fly.dev',
    credential: 'test-token', fetchImplementation,
  });
  assert.deepEqual(sent, ['read', 'create']);
  assert.equal(result.working, true);
});

test('Fly absent-certificate GraphQL error creates the hostname, then reports its DNS needs', async () => {
  const sent = [];
  const fetchImplementation = async (_url, options) => {
    const isCreate = JSON.parse(options.body).query.includes('mutation');
    sent.push(isCreate ? 'create' : 'read');
    return { json: async () => isCreate
      ? { data: { addCertificate: { certificate: {
        configured: false,
        acmeDnsConfigured: true,
        hostname: 'harness.example.com',
      } } } }
      : { errors: [{ message: 'Could not find AppCertificate' }] } };
  };
  const result = await askTheHostProviderForACertificate({
    application: 'example', hostname: 'harness.example.com',
    applicationHost: 'example.fly.dev', credential: 'test-token', fetchImplementation,
  });
  assert.deepEqual(sent, ['read', 'create']);
  assert.equal(result.working, false);
  assert.ok(result.still_needs[0].includes('harness'));
});

test('the provider own words come back when it refuses', async () => {
  // Rewriting them would hide which of several things went wrong: a wrong app
  // name, an expired sign-in, a hostname already claimed by another app.
  const fetchImplementation = async () => ({
    json: async () => ({ errors: [{ message: 'Hostname already exists on app' }] }),
  });
  await assert.rejects(
    askTheHostProviderForACertificate({
      application: 'example', hostname: 'app.example.com', credential: 't', fetchImplementation,
    }),
    /Hostname already exists on app/,
  );
});

test('the credential never appears in the request body', async () => {
  // It belongs in the header. A token in a body is a token in a log.
  let body = '';
  const fetchImplementation = async (_url, options) => {
    body = options.body;
    return { json: async () => ({ data: { app: { certificate: READY } } }) };
  };
  await askTheHostProviderForACertificate({
    application: 'example', hostname: 'app.example.com', credential: 'secret-token', fetchImplementation,
  });
  assert.ok(!body.includes('secret-token'));
});

test('says what the domain still needs, and says nothing when it needs nothing', () => {
  assert.deepEqual(whatTheDomainStillNeeds(READY, 'app.example.com', 'example.fly.dev'), []);

  const waiting = {
    configured: false,
    acmeDnsConfigured: false,
    dnsValidationHostname: '_acme-challenge.app.example.com',
    dnsValidationTarget: 'app.example.com.abc.flydns.net.',
  };
  const needs = whatTheDomainStillNeeds(waiting, 'app.example.com', 'example.fly.dev');
  assert.equal(needs.length, 2);
  assert.ok(needs[0].includes('"app"'));
  assert.ok(needs[0].includes('example.fly.dev'));
  assert.ok(needs[1].includes('_acme-challenge.app.example.com'));
});

test('says so rather than reporting nothing when the provider answered with no certificate', () => {
  const said = whatTheDomainStillNeeds(null, 'app.example.com', 'example.fly.dev');
  assert.equal(said.length, 1);
  assert.match(said[0], /did not answer with a certificate/);
});

test('refuses a request that does not name both an app and a hostname', () => {
  for (const build of [certificateRequest, certificateReadRequest]) {
    assert.throws(() => build('', 'app.example.com'), /application name is required/);
    assert.throws(() => build('example', ''), /hostname is required/);
  }
});
