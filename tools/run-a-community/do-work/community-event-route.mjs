// Original event HTTP clauses, freshly adapted only after normal baseline
// 64fecded. The separately archived preliminary draft is not source evidence.
import { nativeCommunityEvents } from '../read-data/community-events.mjs';
import { createCommunityMemberships } from '../read-data/community-memberships.mjs';
// HELD: nativeSpacePermissions from the declared space-permissions public owner.
// HELD: mailSettings from the maintained sender owner's public read-only API.

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message, status, code) => Object.assign(new Error(message), { status, code });
const json = (value, status = 200) => Response.json(value, { status });

export function nativeCommunityTask(task) {
  const context = object(task) ? task.context : null;
  if (!object(context) || typeof context.account_id !== 'string' || !context.account_id
    || !['account', 'share_act'].includes(context.admission)
    || typeof task.request_key !== 'string' || !task.request_key || task.task_id !== task.request_key)
    throw fail('The community route has no admitted native task context.', 503, 'community_context_unavailable');
  const actor = context.actor;
  if (actor !== undefined && (!object(actor) || !['account', 'person'].includes(actor.kind)
    || typeof actor.id !== 'string' || !actor.id))
    throw fail('The native actor context is invalid.', 503, 'community_context_unavailable');
  if (context.admission === 'account' && (actor?.kind !== 'account' || actor.id !== context.account_id)
    || context.admission === 'share_act' && actor !== undefined && actor.kind !== 'person')
    throw fail('The native actor does not match its admission.', 503, 'community_context_unavailable');
  return Object.freeze({
    account_id: context.account_id, admission: context.admission, request_key: task.request_key,
    ...(actor === undefined ? {} : { actor: Object.freeze({ kind: actor.kind, id: actor.id }) }),
  });
}

function statusOf(error) {
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) return error.status;
  if (error?.committed === true) return 503;
  if (error?.code === 'original_command_conflict') return 409;
  if (['current_workspace_rights_refused', 'capability_gone', 'refused'].includes(error?.code)) return 403;
  if (error?.code === 'original_input_refused') return 400;
  if (typeof error?.code === 'string' || error instanceof TypeError || error instanceof ReferenceError) return 503;
  return 400;
}

/** Current shared event API + actual actor-space reader, not a retired backend. */
export async function handleCommunityEventRequest(network, request, caller) {
  try {
    const url = new URL(request.url);
    const body = request.method === 'GET' ? {} : await request.json().catch(() => ({}));
    const me = await caller();
    const call = (method, pattern) => request.method === method && url.pathname.match(pattern)?.slice(1).map(decodeURIComponent);
    let found;
    if ((found = call('POST', /^\/community\/events\/([^/]+)\/rsvp$/))) return json(await network.rsvp({ ...me, event_id: found[0], going: body.going !== false }));
    if ((found = call('POST', /^\/community\/events\/([^/]+)\/cancel$/))) return json(await network.cancelEvent({ ...me, community_id: String(body.community_id ?? ''), event_id: found[0] }));
    if ((found = call('POST', /^\/community\/events\/([^/]+)\/move$/))) return json(await network.moveEvent({ ...me, community_id: String(body.community_id ?? ''), event_id: found[0], starts_at: body.starts_at, ends_at: body.ends_at, title: body.title, about: body.about }));
    if ((found = call('GET', /^\/community\/events$/))) {
      // Every space I am in is asked; a space with no events, or none I may see, answers an empty list.
      const span = { from: url.searchParams.get('from'), to: url.searchParams.get('to') };
      const { spaces } = await network.spaces({ relay: me.relay });
      const read = await Promise.all(spaces.map(space => network.spaceEvents({ ...me, community_id: space.space_id, ...span })));
      return json({ ...span, events: read.flatMap(space => space.events.map(event => ({ ...event, space_id: space.space_id, space_title: space.title }))) });
    }
    if ((found = call('POST', /^\/community\/([^/]+)\/events$/))) return json(await network.createEvent({ ...me, community_id: found[0], title: body.title, about: body.about, starts_at: body.starts_at, ends_at: body.ends_at, size_limit: body.size_limit, repeats: body.repeats ?? null }));
    if ((found = call('GET', /^\/community\/events\/([^/]+)\/calendar$/))) return new Response(await network.eventFile({ ...me, event_id: found[0] }), { headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'attachment; filename="event.ics"' } });
    return json({ error: 'Not found' }, 404);
  } catch (error) {
    return json({
      error: String(error?.message ?? error),
      ...(typeof error?.code === 'string' ? { code: error.code } : {}),
      ...(error?.next_call ? { next_call: error.next_call } : {}),
      ...(error?.committed === true ? { committed: true, result: error.result, effect: error.effect } : {}),
    }, statusOf(error));
  }
}

function requestOf(input) {
  if (!object(input) || typeof input.path !== 'string' || !input.path.startsWith('/')
    || input.path.startsWith('//') || /[?#]/.test(input.path)
    || !['GET', 'POST'].includes(input.method))
    throw fail('A community event request needs its route path and GET or POST method.', 400, 'community_route_invalid');
  const query = input.query ?? {};
  if (!object(query) || Object.values(query).some(value => typeof value !== 'string')
    || input.method !== 'GET' && input.body !== undefined && !object(input.body))
    throw fail('The community query and body are invalid.', 400, 'community_route_invalid');
  const url = new URL(input.path, 'https://native.invalid');
  url.search = new URLSearchParams(query).toString();
  return new Request(url, input.method === 'GET' ? {} : {
    method: input.method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(input.body ?? {}),
  });
}

/** Native generic text transport is still separately qualified by its owner. */
export async function nativeCommunityResponse(response) {
  if (!(response instanceof Response)) throw fail('The community owner returned no response.', 503, 'community_response_unavailable');
  if (response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() === 'text/calendar') return {
    status: response.status, body: await response.text(),
    http: { format: 'text', content_type: 'text/calendar; charset=utf-8', download_name: 'event.ics' },
  };
  return { status: response.status, body: await response.json() };
}

/**
 * Assemble real shared owners for one native run. Runtime callbacks are required
 * adapters supplied by their current owners, never functions from input/DATA.
 * resolveIdentity returns holds:null for unknown paid evidence, not an invented
 * empty grant list. Membership eligibility decides when that proof is needed.
 * The native CLI/catalogue binding remains held until those owners are available.
 */
export async function createCommunityEventRoute({
  door, task, model, membership_labels, current, resolveIdentity,
  permissionOptions, spaces, spaceChanged, tellEventCalendars, tellMembersOfMeetingChange,
  calendarUidDomain, newId,
} = {}) {
  const context = nativeCommunityTask(task);
  if (!door || typeof door.resource !== 'string' || !door.resource)
    throw fail('The current records-door resource is unavailable.', 503, 'community_resource_unavailable');
  if ([current, resolveIdentity, permissionOptions, spaces, spaceChanged,
    tellEventCalendars, tellMembersOfMeetingChange, newId].some(fn => typeof fn !== 'function')
    || typeof calendarUidDomain !== 'string' || !calendarUidDomain || /[\r\n]/.test(calendarUidDomain))
    throw fail('The current community runtime bindings are unavailable.', 503, 'community_bindings_unavailable');
  const resource = door.resource;
  const memberships = createCommunityMemberships({
    door, model, membership_labels, requestKey: () => context.request_key,
  });
  let snapshot;
  const refresh = async (operation, input) => {
    const admitted = await current(operation, input);
    if (admitted !== true) throw fail('The native community admission is not current.', admitted === false ? 403 : 503,
      admitted === false ? 'community_admission_denied' : 'community_admission_unknown');
    // Identity withheld by native admission stays absent; no account fallback
    // or private holdings lookup is performed for an undisclosed actor.
    const identity = context.actor
      ? await resolveIdentity({ context, door, memberships })
      : { relay: null, holds: null };
    if (!object(identity) || !(identity.relay === null || typeof identity.relay === 'string' && identity.relay)
      || !(identity.holds === null || Array.isArray(identity.holds))
      || ['allowed', 'status', 'state', 'error'].some(key => Object.hasOwn(identity, key)))
      throw fail('The native membership identity is unavailable.', 503, 'community_identity_unavailable');
    if (context.actor && identity.relay === null)
      throw fail('The native actor has no verified membership identity.', 503, 'community_identity_unavailable');
    snapshot = Object.freeze({
      resource, relay: identity.relay, holds: structuredClone(identity.holds),
      ...(context.actor ? { actor: context.actor } : {}),
    });
    return true;
  };
  await refresh('community:request', {});
  const principal = () => snapshot;
  const permissions = new Map();
  const permissionsFor = spaceId => {
    if (!permissions.has(spaceId)) {
      const options = permissionOptions(spaceId);
      if (!object(options)) throw fail('The current space permission bindings are unavailable.', 503, 'community_permission_unavailable');
      permissions.set(spaceId, nativeSpacePermissions({
        ...options, records: memberships, spaceId, resource, principal, current: refresh,
        joinedByRules: memberships.joinedByRules,
      }));
    }
    return permissions.get(spaceId);
  };
  const events = nativeCommunityEvents({
    memberships, resource, principal, current: refresh,
    readCommunity: async id => {
      await permissionsFor(id).allowedInSpace(id, principal().relay, 'read_space');
      return memberships.readCommunity(id);
    },
    activeMember: memberships.activeMember,
    checkedMember: memberships.checkedMember,
    checkedMay: async (id, relay, action, holds) => {
      const community = await memberships.checkedMember(id, relay, holds);
      await permissionsFor(id).allowedInSpace(id, relay, action);
      return community;
    },
    mayIn: (community, relay, ids) => permissionsFor(community.id).mayIn(community, relay, ids),
    spaceChanged, tellEventCalendars, tellMembersOfMeetingChange, newId,
    calendarUid: id => id + '@' + calendarUidDomain,
    calendarOrganizer: async community => {
      const name = community.config.owner_name ?? community.config.title;
      if (typeof community.config.mail?.reply_to === 'string' && community.config.mail.reply_to.trim())
        return { name, email: community.config.mail.reply_to };
      const settings = await mailSettings(door, undefined, { initialize: false });
      if (typeof settings?.from?.email !== 'string' || !settings.from.email.trim())
        throw fail('The account has no current calendar organizer.', 503, 'community_organizer_unavailable');
      return { name, email: settings.from.email };
    },
  });
  const network = {
    ...events,
    async spaces({ relay }) {
      if (!context.actor) throw fail('Reading personal event collections needs a disclosed actor.', 403, 'community_identity_withheld');
      const result = await spaces({ relay });
      if (!object(result) || !Array.isArray(result.spaces) || result.complete === false
        || ['error', 'status', 'state'].some(key => Object.hasOwn(result, key))
        || result.spaces.some(space => !object(space) || typeof space.space_id !== 'string' || !space.space_id || typeof space.title !== 'string'))
        throw fail('The current actor-space collection is unavailable.', 503, 'community_spaces_unavailable');
      return result;
    },
  };
  const caller = async () => ({ relay: principal().relay, holds: principal().holds });
  return Object.freeze({
    async request(input) {
      try {
        const request = requestOf(input);
        await refresh('community:request', input);
        return nativeCommunityResponse(await handleCommunityEventRequest(network, request, caller));
      } catch (error) {
        return { status: statusOf(error), body: { error: String(error?.message ?? error), ...(error?.code ? { code: error.code } : {}) } };
      }
    },
  });
}

