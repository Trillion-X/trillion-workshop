// The upload's browser sign-in reads the sign-in server's addresses from its discovery document (RFC 8414); it types no path.
import assert from 'node:assert/strict';
import test from 'node:test';
import { signInWithBrowser } from '../do-work/send-a-folder-to-a-namespace.mjs';

test('registration, authorize and token are the addresses the server names, wherever they are', async () => {
  const asked = [];
  const document = { registration_endpoint: 'https://issuer.example/x/register', authorization_endpoint: 'https://issuer.example/x/authorize', token_endpoint: 'https://issuer.example/x/exchange' };
  const fetchImpl = async (address, init) => {
    asked.push(String(address));
    if (String(address).endsWith('/.well-known/oauth-authorization-server')) return Response.json(document);
    if (String(address) === document.registration_endpoint) return Response.json({ client_id: 'c1' });
    if (String(address) === document.token_endpoint) return Response.json({ access_token: 'a1' });
    return fetch(address, init);
  };
  const header = await signInWithBrowser({ origin: 'https://issuer.example/', fetchImpl, showSignIn: async address => {
    assert.ok(address.startsWith('https://issuer.example/x/authorize?'));
    const redirect = new URL(address).searchParams.get('redirect_uri');
    await fetch(`${redirect}?code=c&state=${new URL(address).searchParams.get('state')}`);
  } });
  assert.equal(await header(), 'Bearer a1');
  assert.deepEqual(asked.filter(address => address.startsWith('https://issuer.example')), [
    'https://issuer.example/.well-known/oauth-authorization-server', document.registration_endpoint, document.token_endpoint]);
});

test('a server that does not name an address is said, not guessed', async () => {
  const fetchImpl = async () => Response.json({ token_endpoint: 'https://issuer.example/t' });
  await assert.rejects(signInWithBrowser({ origin: 'https://issuer.example', fetchImpl, showSignIn: async () => {} }), /does not name its registration_endpoint/);
});
