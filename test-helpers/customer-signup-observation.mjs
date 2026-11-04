// Observe only the original signup. Challenges stay in this closure; callers
// receive only an exact UUID after a matching successful finish and session GET.
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function observeProofSignup(page, { origin, proofName }) {
  const pending = [], options = [], finishes = [];
  let readback;
  const response = reply => {
    const path = new URL(reply.url());
    if (path.origin !== origin || !['/passkey/options', '/passkey/finish'].includes(path.pathname)) return;
    pending.push((async () => {
      const request = reply.request();
      if (request.method() !== 'POST') return;
      const input = request.postDataJSON();
      if (input?.mode !== 'create' || input.name !== proofName || !reply.ok()) return;
      const body = await reply.json();
      if (path.pathname === '/passkey/options' && typeof body.challenge_id === 'string')
        options.push(body.challenge_id);
      if (path.pathname === '/passkey/finish' && typeof input.challenge_id === 'string') {
        const id = typeof body.keep_passkeys?.user_id === 'string'
          ? Buffer.from(body.keep_passkeys.user_id, 'base64url').toString('utf8') : null;
        if (uuid.test(id ?? '')) finishes.push({ challenge: input.challenge_id, id });
      }
    })().catch(() => {}));
  };
  page.on('response', response);
  const match = async () => {
      let timer;
      const complete = await Promise.race([Promise.all(pending).then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); })]).finally(() => clearTimeout(timer));
      if (!complete) return null;
      if (options.length !== 1 || finishes.length !== 1 || finishes[0].challenge !== options[0]) return null;
      try {
        const r = await page.context().request.get(`${origin}/work/api/viewer`, { timeout: 10000 });
        if (!r.ok() || !(r.headers()['content-type'] ?? '').includes('json')) return null;
        const body = await r.json();
        return body.user_id === finishes[0].id ? body.user_id : null;
      } catch { return null; }
  };
  return {
    stop: () => page.off('response', response),
    matchingSessionIdentity: () => readback ??= match(),
  };
}
