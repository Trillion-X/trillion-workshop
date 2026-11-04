// src/work-spaces.mjs
//
// PURPOSE
//   The Spaces screens of the signed-in workspace (src/workspace/spaces-screen.tsx) reach the person's spaces
//   through this page's own session: the same person-side routes an AI uses (src/person-spaces.mjs, and the network
//   invitation answer and leave in src/person-network.mjs), passed to the person's own store unchanged. The two roads
//   the Worker answers itself for an AI (a key with a chosen reach, a whole chat export read from the person's files)
//   are handed in by the Worker as makeKey and importExport, so this page takes the same ones.
//
//   GET  /work/api/spaces?archived                     the spaces this person is in, less the ones they archived
//                                                      (archived=true: only those)
//   GET  /work/api/spaces/invitations                  invitations into a space waiting for this person's answer
//   POST /work/api/spaces/invitations/answer           { request_id, accept }
//   POST /work/api/spaces/start                        { title }   a new project with only this person in it
//   GET  /work/api/spaces/shareable?kind&after         the person's own things that can be shared, one page, answered at
//                                                      the account's own records (src/space-shareable.mjs; files are read
//                                                      from /work/api/namespace/names)
//   GET  /work/api/spaces/join/<code>                  what an invite link opens: { space: { title, label, description,
//                                                      members }, expires_at, already_member }
//   POST /work/api/spaces/join/<code>                  join with it: { space_id, joined }
//   GET  /work/api/spaces/<id>                         one space: members by the name they show there, agents
//   GET  /work/api/spaces/<id>/items?kind&before&limit its items, newest first
//   GET  /work/api/spaces/<id>/responses?record&part&before&limit    the record's exact-part replies, or bounded
//                                                      replies across all its parts when all_parts=true
//   GET  /work/api/spaces/<id>/items/<item>/file       where a shared file's bytes are read: { identity, url,
//                                                      url_expires_at }, a lease address on this service the page loads as is
//   GET  /work/api/spaces/<id>/items/<item>/bytes      the same bytes at one lasting address (sent on to that lease), for a board card
//   GET  /work/api/spaces/<id>/items/<item>/transcript the shared recording's kept text and timed segments only,
//                                                      checked against current membership and source availability
//   POST /work/api/spaces/<id>/(items|share|withdraw|name|agents/find|handoffs/read)
//   POST /work/api/spaces/<id>/items/<item>/react      { symbol?, glyph?, on? }   a reaction given or taken back (src/responses.mjs)
//   POST /work/api/spaces/<id>/handoffs                { job, request_key, to_agent?, case_id? }   hand a job to an agent
//   POST /work/api/spaces/<id>/import                  { file, offset?, limit? }   a chat export from the person's files
//   POST /work/api/spaces/<id>/keys                    a key for an AI that reaches this one space and nothing private
//   POST /work/api/spaces/<id>/leave                   leave the space
//   GET  /work/api/spaces/<id>/rules                   who may do what here: { rules, may_change, facts, actions }
//   POST /work/api/spaces/<id>/rules                   { rules }   replace them (null: the rules every space starts with)
//   POST /work/api/spaces/<id>/(members/type|members/remove|member-types|member-types/remove|hide)   member types and hiding (src/space-member-types.mjs)
//   PUT  /work/api/spaces/<id>/member-types            replace member types (src/space-member-types.mjs)
//   POST /work/api/spaces/<id>/archive                 { archived }   archive it from this person's own lists, or put it back
//   POST /work/api/spaces/<id>/seen                    the person has seen everything there (unread starts again)
//   POST /work/api/spaces/<id>/about                   { description?, picture?, colour? }   the space's words, picture (a file) and colour
//   GET  /work/api/spaces/<id>/picture                 where the picture's bytes are read: { identity, url, url_expires_at }
//   POST /work/api/spaces/<id>/invites                 { days? }   a one-time invite link: { invite_id, url, expires_at }
//   GET  /work/api/spaces/<id>/invites                 the invite links this person made there, and what became of each
//   POST /work/api/spaces/<id>/invites/revoke          { invite_id }
//   POST /work/api/spaces/<id>/invite-person           { email?, phone?, name?, member_type?, days? }   invite one person
//                                                      and tell them (src/space-invitation.mjs), from the sharing sheet
//   GET  /work/api/spaces/<id>/tools/added             the tools added to the space, named (src/person-spaces.mjs addedTools)
//   POST /work/api/spaces/<id>/tools/grant             { tool_id, member_id: "*" }   add any published tool for everyone there
//   POST /work/api/spaces/<id>/tools/remove            { tool_id }   take a tool out of the space for everyone
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here decides anything about a space: every answer is the person store's own, word for word, so the
//      screen and the person's AI can never disagree. Membership is checked there, never here.
//   2. The person is the session's account; the request carries no reach header from the browser, so the store reads
//      it as the account itself (src/person-spaces.mjs reachOf).
//   3. Only the verbs the screen offers pass: agents are found and handed work here, never published, given capacity,
//      taken or finished.
//   4. A key made here reaches only the space it was made in: the browser never chooses its reach.
//   5. Writes come only from this service's own pages (the origin check every /work/api write makes).

// Associated records and saved visible-card posters use the same session and owner as shared files.

const json = (value, status = 200) => Response.json(value, { status });
const PASSED = new Set(['GET ', 'GET items', 'GET responses', 'GET items/*/file', 'GET items/*/transcript', 'POST items', 'POST items/*/react', 'POST responses/react', 'POST responses/resolve', 'POST share', 'POST withdraw', 'POST name', 'POST agents/find', 'POST handoffs', 'POST handoffs/read', 'POST seen', 'POST about', 'GET picture', 'POST invites', 'POST invite-person', 'GET invites', 'POST invites/revoke', 'GET rules', 'POST rules', 'POST members/type', 'POST members/remove', 'POST member-types', 'POST member-types/remove', 'POST hide', 'GET tools/added', 'POST tools/grant', 'POST tools/remove', 'POST archive']);
const HANDOFF_FIELDS = ['job', 'request_key', 'to_agent', 'case_id'];
PASSED.add('GET items/*/references');
PASSED.add('GET previews');
PASSED.add('GET records/*');
PASSED.add('POST records/*');
PASSED.add('DELETE records/*');
PASSED.add('PUT member-types');
PASSED.add('POST members/joining-type');
const only = (body, fields) => Object.fromEntries(fields.filter(field => body[field] !== undefined).map(field => [field, body[field]]));

export const isWorkSpacesPath = path => path === '/work/api/spaces' || path.startsWith('/work/api/spaces/');

const ask = (person, origin, method, path, body) => person.fetch(new Request(`https://person${path}`, {
  method,
  headers: { 'content-type': 'application/json', 'x-trillion-origin': origin },
  ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
}));

export async function handleWorkSpaces(request, { person, origin, url, makeKey, importExport }) {
  if (request.method !== 'GET' && request.headers.get('origin') !== origin) return json({ error: 'Not allowed.' }, 403);
  const body = request.method === 'GET' ? null : await request.json().catch(() => ({}));
  const rest = url.pathname.slice('/work/api/spaces'.length);
  if (rest === '' && request.method === 'GET') return ask(person, origin, 'GET', `/spaces${url.search}`);
  // Accepting or declining an invitation is part of opening that space, even when this person cannot use the paid
  // Network screen: the account's own /spaces/invitations routes (src/person-spaces.mjs).
  if (rest === '/invitations' && request.method === 'GET') return ask(person, origin, 'GET', '/spaces/invitations');
  if (rest === '/invitations/answer' && request.method === 'POST') return ask(person, origin, 'POST', '/spaces/invitations/answer', { request_id: body.request_id, accept: body.accept });
  if (rest === '/start' && request.method === 'POST') return ask(person, origin, 'POST', '/spaces', { title: body.title, ...(body.members_are !== undefined ? { members_are: body.members_are } : {}), ...(Array.isArray(body.members) && body.members.length ? { members: body.members } : {}) });
  const join = /^\/join\/([^/]+)$/.exec(rest);
  if (join) return ask(person, origin, request.method, `/spaces/join/${join[1]}`, {});
  const [spaceId, ...section] = rest.slice(1).split('/').map(decodeURIComponent);
  if (!spaceId) return json({ error: 'Not found' }, 404);
  const route = `${request.method} ${section.join('/')}`;
  if (route === 'POST leave') return ask(person, origin, 'POST', '/network/leave', { membership_id: spaceId });
  try {
    if (route === 'POST keys') return json(await makeKey({ private: false, spaces: [spaceId] }));
    if (route === 'POST import') {
      // The road bring_in_chat_export takes: the export is read from the person's files, and each chat is kept
      // through the store's import into this space.
      const keep = async (path, chat) => {
        const answered = await ask(person, origin, 'POST', path, chat);
        const result = await answered.json();
        if (!answered.ok) throw new Error(result.error ?? `Request failed (${answered.status})`);
        return result;
      };
      return json(await importExport({ file: body.file, offset: body.offset, limit: body.limit, space_id: spaceId }, keep));
    }
  } catch (error) {
    return json({ error: error.message }, 400);
  }
  // A shared picture's bytes at one lasting address, so a board card shows it to every member: each read is sent on
  // to the short-lived address the file is read from now.
  if (request.method === 'GET' && section.length === 3 && section[0] === 'items' && section[2] === 'bytes') {
    const answered = await ask(person, origin, 'GET', `/spaces/${encodeURIComponent(spaceId)}/items/${encodeURIComponent(section[1])}/file`);
    const found = await answered.json();
    if (!answered.ok || typeof found.url !== 'string') return json(found, answered.ok ? 404 : answered.status);
    return new Response(null, { status: 302, headers: { location: found.url, 'cache-control': 'private, max-age=60' } });
  }
  const shape = section.map((part, index) => ((section[0] === 'items' || section[0] === 'records') && index === 1 ? '*' : part)).join('/');
  if (!PASSED.has(`${request.method} ${shape}`)) return json({ error: 'Not found' }, 404);
  const sent = route === 'POST handoffs' ? only(body, HANDOFF_FIELDS) : body;
  const path = `/spaces/${encodeURIComponent(spaceId)}${section.length ? `/${section.map(encodeURIComponent).join('/')}` : ''}${request.method === 'GET' ? url.search : ''}`;
  return ask(person, origin, request.method, path, sent);
}
