// src/work-sharing.mjs
//
// PURPOSE
//   The sharing sheet in the signed-in workspace (src/workspace/sharing-sheet.tsx) reaches the person's own sharing
//   owner (src/record-sharing.mjs) through this page's session: the same person-side routes an AI uses, passed to the
//   person's own store unchanged.
//
//   GET  /work/api/sharing/<record>            the sheet for one record
//   POST /work/api/sharing/<record>/preview    { leave_out }   the copy others would see with those fields left out
//   POST /work/api/sharing/<record>            { network?, spaces?, people?, chain?, leave_out? }   choose
//   GET  /work/api/shared-with-me              what people shared with this person
//   POST /work/api/shared-with-me/read         { offer_id }
//
//   The Sharing screen (src/workspace/sharing-screen.tsx) reaches the one list of where shares go
//   (src/share-destinations.mjs) and what was shared before the same way:
//   GET/POST /work/api/share-destinations      the list, and changing it
//   POST /work/api/share-destinations/deliver  sending a share again (deliver_share)
//   GET  /work/api/shares?limit&before         shared before, from every device (src/share-history.mjs)
//   GET  /work/api/share-agents                the person's AIs that take work, for "Which AI takes it"
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here decides anything: every answer is the person store's own, word for word, so the sheet and the
//      person's AI can never disagree.
//   2. Writes come only from this service's own pages (the origin check every /work/api write makes).

import { refusalStatus } from '../../shared-code/src/failure.mjs';

const PREFIX = '/work/api';
const PASSED = new Set(['/shared-with-me', '/shared-with-me/read', '/share-destinations', '/share-destinations/deliver', '/shares', '/share-agents']);

export const isWorkSharingPath = path => path.startsWith(`${PREFIX}/sharing/`) || (path.startsWith(PREFIX) && PASSED.has(path.slice(PREFIX.length)));

// sharesSent(search): the share list after kept shares join it (src/share-history.mjs), read where Files are.
// deliver(text): the delivery that keeps a share at the edge when the store cannot answer (src/share-inbox.mjs).
// nativeAgents(): an explicitly supplied lazy native owner (execute, ensureReady) for /share-agents only; omission
// retains the caller.
export async function handleWorkSharing(request, options) {
  const { person, userId, origin, url, sharesSent, deliver = null } = options;
  if (request.method !== 'GET' && request.headers.get('origin') !== origin) return Response.json({ error: 'Not allowed.' }, { status: 403 });
  const path = url.pathname.slice(PREFIX.length);
  if (path === '/shares') {
    try { return Response.json(await sharesSent(url.search)); } catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
  }
  if (path === '/share-destinations/deliver' && request.method === 'POST' && deliver) return deliver(await request.text());
  if (path === '/share-agents') {
    const project = listed => Response.json({ agents: (listed.agents ?? []).filter(agent => agent.takes_work !== false).map(agent => ({ agent_id: agent.agent_id, name: agent.name || agent.agent_id, ready_now: agent.ready_now === true })) });
    // An omitted supplier keeps the existing caller. A supplied native failure
    // belongs to that owner and must never be rescued from the former account.
    if (Object.hasOwn(options, 'nativeAgents')) {
      const nativeAgents = options.nativeAgents;
      const unavailable = () => Response.json({ error: 'Your AIs could not be listed.' }, { status: 503 });
      if (typeof nativeAgents !== 'function') return unavailable();
      const native = await nativeAgents();
      if (typeof native?.execute !== 'function' || typeof native.ensureReady !== 'function') return unavailable();
      // The account's agent registry is its own records' claims owner (claims:find), called directly.
      let listed;
      try {
        await native.ensureReady('@own-records');
        listed = await native.execute('@own-records', 'claims:find', { limit: 20 }, `share-agents:${crypto.randomUUID()}`);
      } catch (error) {
        const status = refusalStatus(error);
        if (status === null) throw error;
        return Response.json({ error: error.message ?? 'Your AIs could not be listed.' }, { status });
      }
      return project(listed);
    }
    const found = await person.fetch(new Request('https://person/agents/find', { method: 'POST', headers: { 'content-type': 'application/json', 'x-trillion-origin': origin, 'x-trillion-user': userId }, body: JSON.stringify({ limit: 20 }) }));
    const listed = await found.json().catch(() => ({}));
    if (!found.ok) return Response.json({ error: listed.error ?? 'Your AIs could not be listed.' }, { status: found.status });
    return project(listed);
  }
  return person.fetch(new Request(`https://person${path}${url.search}`, {
    method: request.method,
    headers: { 'content-type': 'application/json', 'x-trillion-origin': origin, 'x-trillion-user': userId },
    ...(request.method === 'GET' ? {} : { body: await request.text() }),
  }));
}
