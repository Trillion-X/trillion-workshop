// One person's side of the network (src/network.mjs), inside their own store: their relay id, their listing and
// their contact details. The contact never leaves this store except to a fellow member, checked live on each read.
//
//   GET  /network                  what is waiting, what I asked, my memberships, and contacts released to me
//   PUT  /network/profile          { findable, offering, seeking, contact }  (findable false removes the listing)
//   POST /network/find             { need }
//   GET  /network/on-your-path     people and open spaces on the same pursuits as this person, by meaning
//   POST /network/request          { to, why, membership_id? } or { proposal_id, pass? }
//   POST /network/answer           { request_id, accept, consent }
//   POST /network/memberships      { label, title, starts_at?, ends_at?, size_limit? }   answers its pursuit_id too
//   POST /network/leave            { membership_id }   a room's id or a pursuit id; ends that pursuit for this person
//   POST /network/label            { relay, label }
const json = (value, status = 200) => Response.json(value, { status });
import rules from '../../introduce-two-people/src/network-settings.json' with { type: 'json' };
import { MATCHED_BY_WORDS, meaningOrNone } from '../../keep-and-wake-ai-sessions-on-this-computer/src/meaning-or-words.mjs';
import { failureOf } from '../../shared-code/src/failure.mjs';
import { cosine } from '../../find-pictures-by-colour-and-likeness/src/meaning.mjs';

export const isNetworkPath = path => path === '/network' || path.startsWith('/network/');

/** People and open spaces on the same pursuits as this person, by meaning: `mine` is their pursuits with embeddings,
 * `caller` the community caller the Network reads open spaces for, `meanings(texts)` embeds each space's words. */
export async function pursuitsOnYourPath({ mine, network, asker, caller, meanings }) {
  if (!mine.length) return { pursuits: 0, people: [], spaces: [] };
  const people = await network.onPath({ asker, pursuits: mine });
  const open = (await network.communities(caller)).filter(item => !item.member && item.may_join).slice(0, 200);
  const embedded = await meanings(open.map(item => `${item.title}. ${item.about ?? ''}`));
  const spaces = open.flatMap((item, index) => {
    let best = null;
    for (const own of mine) {
      const similarity = cosine(own.embedding, embedded[index]);
      if (similarity >= rules.on_your_path.min_similarity && (!best || similarity > best.similarity)) best = { similarity: Math.round(similarity * 100) / 100, yours: own.title };
    }
    return best ? [{ community_id: item.community_id, title: item.title, about: item.about, members: item.members, ...best }] : [];
  }).sort((a, b) => b.similarity - a.similarity).slice(0, rules.on_your_path.spaces);
  return { pursuits: mine.length, people, spaces };
}

export async function handleNetworkRequest(person, request) {
  try {
    const url = new URL(request.url);
    const body = request.method === 'GET' ? {} : await request.json().catch(() => ({}));
    const network = person.network();
    const me = { relay: person.relay(), person_ref: person.ctx.id.toString() };
    const route = `${request.method} ${url.pathname}`;
    if (route === 'GET /network') {
      await person.fillNetworkProfile();
      // Reading your own network is where you learn the id you give someone to invite you, so from then on an
      // invitation to it reaches you (the network knows only how to route to it, never who you are).
      await network.remember(me.relay, me.person_ref);
      const inbox = await network.inbox(me.relay);
      // Each membership's other members, with their contact read now from their own store if they still share it.
      for (const membership of inbox.memberships) {
        membership.others = await Promise.all(membership.others.map(async other => ({
          relay: other.relay,
          contact: await (person.releaseNetworkContact
            ? person.releaseNetworkContact({ ...other, membership_id: membership.membership_id, asking_relay: me.relay })
            : person.env.PERSON.get(person.env.PERSON.idFromString(other.person_ref)).releaseContact({ membership_id: membership.membership_id, asking_relay: me.relay })),
        })));
      }
      return json({ you: { relay: me.relay, ...person.profile() }, ...inbox });
    }
    if (route === 'GET /network/profile') return json(person.profile());
    if (route === 'PUT /network/profile') return json(await person.setProfile(body));
    if (route === 'POST /network/ensure-profile') return json(await person.fillNetworkProfile());
    if (route === 'GET /network/ai-pings') return json(await person.networkAiPings());
    if (route === 'PUT /network/ai-pings') return json(await person.setNetworkAiPings(body));
    if (route === 'POST /network/ai-pings') return json(await network.pingAi({ ...body, from: me.relay, person_ref: me.person_ref }));
    if (person.staysOwner && route === 'GET /network/stays') return json(await person.staysOwner.list({ host_relay: url.searchParams.get('host_relay') }));
    if (person.staysOwner && route === 'PUT /network/stays') return json(await person.staysOwner.save(body));
    if (person.staysOwner && route === 'POST /network/stays/ask') return json(await person.staysOwner.ask(body));
    if (person.staysOwner && route === 'GET /network/stays/request') return json(await person.staysOwner.request({ request_id: url.searchParams.get('request_id') }));
    if (route === 'GET /network/stays') return json(await network.staysOf({ relay: me.relay, host_relay: url.searchParams.get('host_relay') }));
    if (route === 'PUT /network/stays') return json(network.saveStay({ ...body, relay: me.relay }, rules));
    if (route === 'POST /network/stays/ask') return json(await network.askStay({ ...body, relay: me.relay, person_ref: me.person_ref }, rules));
    if (route === 'GET /network/stays/request') return json(network.stayRequestFor({ relay: me.relay, request_id: url.searchParams.get('request_id') }));
    if (route === 'GET /network/people') {
      await person.fillNetworkProfile();
      let before = null;
      try { before = url.searchParams.get('before') ? JSON.parse(url.searchParams.get('before')) : null; } catch { throw new Error('The next page is not valid.'); }
      return json(await network.browse({ asker: me.relay, before, limit: url.searchParams.get('limit') }));
    }
    if (route === 'GET /network/person') {
      const relay = url.searchParams.get('relay');
      const listing = await network.publicPerson({ asker: me.relay, relay });
      if (!listing) return json({ error: 'This person is not available.' }, 404);
      const publicDetails = await (person.publicNetworkPersonProfile
        ? person.publicNetworkPersonProfile({ relay, person_ref: listing.person_ref, asking_relay: me.relay })
        : person.env.PERSON.get(person.env.PERSON.idFromString(listing.person_ref)).publicNetworkProfile());
      if (!publicDetails) return json({ error: 'This person is not available.' }, 404);
      const { person_ref, ...card } = listing;
      return json({ ...card, ...publicDetails, yours: relay === me.relay });
    }
    if (route === 'POST /network/find') {
      if (typeof body.need !== 'string' || !body.need.trim()) throw new Error('Say who you are looking for.');
      // When the model road is stopped people are matched by the words of what they offer and seek, and the answer says so.
      const meaning = await meaningOrNone(() => person.embed(body.need, 'embedding:network-need'));
      return json({ people: await network.find({ asker: me.relay, embedding: meaning, need: body.need }), ...(meaning ? {} : { matched_by_words: MATCHED_BY_WORDS }) });
    }
    if (route === 'GET /network/on-your-path') return json(await person.onYourPath());
    if (route === 'POST /network/request') return json(await network.request({ from: me.relay, person_ref: me.person_ref, to: String(body.to ?? ''), why: body.why, membership_id: body.membership_id ?? null, proposal_id: body.proposal_id ?? null, pass: body.pass === true }));
    if (route === 'POST /network/answer') return json(await network.answer({ relay: me.relay, request_id: String(body.request_id ?? ''), accept: body.accept === true, consent: body.consent }));
    // A new group, project, event or community is one of the person's pursuits from the moment it exists, and leaving
    // one ends that pursuit for them (src/pursuit-rooms.mjs): both answer with the pursuit too.
    if (route === 'POST /network/memberships') {
      const made = await network.createMembership({ ...body, relay: me.relay, person_ref: me.person_ref });
      person.forgetRooms();
      return json({ ...made, pursuit_id: (await person.pursuitOfRoom(made.membership_id))?.id ?? null });
    }
    if (route === 'POST /network/leave') {
      const named = String(body.membership_id ?? '');
      const pursuit = named.startsWith('pursuit:') ? await person.ownPursuit(named) : await person.pursuitOfRoom(named);
      if (pursuit) return json({ left: pursuit.space_id ?? null, ...(await person.leavePursuit(pursuit.id)) });
      return json(await network.leave({ relay: me.relay, membership_id: named }));
    }
    if (route === 'POST /network/label') return json(await network.label({ by: me.relay, relay: String(body.relay ?? ''), label: body.label }));
    return json({ error: 'Not found' }, 404);
  } catch (error) {
    if (person.nativeNetwork && (failureOf(error).tries_again_later || error.status >= 500)) throw error;
    return json({ error: error.message }, person.nativeNetwork ? error.status ?? 400 : 400);
  }
}
