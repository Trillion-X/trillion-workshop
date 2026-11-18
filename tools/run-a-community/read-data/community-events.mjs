// Event actions restored from the complete immutable methods in source-baselines.
// Memberships remain the space's existing records; this owner owns no store.
import { eventTimes } from './event-times.mjs';
import { memberDecision, checkedMemberDecision } from './community-access.mjs';
// HELD: calendarInviteFile from the declared booking invitation owner awaits
// shared public-import admission proof. The exporter is intentionally unbound.

const HOUR = 3600000;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const defaultId = prefix => prefix + '_' + crypto.randomUUID().replaceAll('-', '');
const text = (value, label, max = 600) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(label + ' is needed');
  return value.trim().slice(0, max);
};
const at = value => {
  if (value == null || value === '') return null;
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) throw new Error('Use a date and time.');
  return time.toISOString();
};
const seesMeetings = (config, member) => config.spaces?.events === 'everyone' || Boolean(member);

/**
 * memberships: read(id), events(parentId), member(eventId,relay),
 * members(eventId), putEvents(rows,actor), putMember(row,actor),
 * removeEvent(id,actor), transaction(async fn).
 * Methods may be async. transaction atomically commits its staged reads/writes
 * with event revision and current auth-row expected preconditions. Removing an
 * event also removes its member rows. A CAS conflict must throw, never succeed.
 *
 * principal is the admitted {resource,relay,holds,actor?}; null holds explicitly
 * means unknown evidence for the membership owner to resolve when needed. No principal field is
 * taken from input. current and checkedMay belong to current owners.
 * Current admission must return true; false denies, and unknown stays unavailable.
 * Checked access returns true or the matching community with valid config;
 * permission decisions and unavailable/error envelopes never grant access.
 * Delivery callbacks receive an immutable event snapshot in a fifth context
 * argument, so cancellation can deliver after removal and atomic commit.
 * Existing native command/delivery owners retain idempotency and recovery.
 * communityValue(id) reads the space as a value; activeMember and checkedMember decide membership from the member
 * row with the pure checks in community-access.mjs (acceptedInvitation is that owner's read, when needed).
 */
export function nativeCommunityEvents({
  memberships, resource, principal, current: currentAdmission, readCommunity, communityValue,
  checkedMay, mayIn, acceptedInvitation, spaceChanged, tellEventCalendars,
  tellMembersOfMeetingChange, calendarOrganizer, calendarUid, newId = defaultId,
} = {}) {
  if (!memberships || ['read', 'events', 'member', 'members', 'putEvents', 'putMember', 'removeEvent', 'transaction']
    .some(name => typeof memberships[name] !== 'function')
    || typeof resource !== 'string' || !resource
    || [principal, currentAdmission, readCommunity, communityValue, checkedMay, mayIn,
      spaceChanged, tellEventCalendars, tellMembersOfMeetingChange, calendarOrganizer, calendarUid, newId].some(fn => typeof fn !== 'function'))
    throw new TypeError('Event actions require the current resource, membership owner, admitted principal, rights and delivery adapters.');

  const current = async (operation, input) => {
    const admitted = await currentAdmission(operation, input);
    if (admitted !== true) throw Object.assign(fail('The current event admission is ' + (admitted === false ? 'denied.' : 'unavailable.'), admitted === false ? 403 : 503),
      { code: admitted === false ? 'event_admission_denied' : 'event_admission_unknown' });
  };

  const methods = {
  async createEvent({ relay, community_id: id, holds = [], title, about = null, starts_at: startsAt, ends_at: endsAt = null, size_limit: sizeLimit = null, repeats = null }) {
    const community = await this.checkedMay(id, relay, 'put_on_events', holds);
    const times = this.eventTimes(at(startsAt) ?? (() => { throw new Error('starts_at is needed'); })(), at(endsAt), repeats);
    const series = times.length > 1 ? newId('series') : null;
    const now = new Date().toISOString();
    const records = [];
    const ids = times.map(time => {
      const eventId = newId('event');
      records.push({ id: eventId, label: 'event', title: text(title, 'A title', 200),
        about: typeof about === 'string' ? about.trim().slice(0, 2000) : null, starts_at: time.starts_at, ends_at: time.ends_at,
        size_limit: Number.isInteger(sizeLimit) ? sizeLimit : null, created_by: relay, created_at: now, parent_id: id, series_id: series });
      return eventId;
    });
    await this.memberships.putEvents(records);
    this.spaceChanged(id, now);
    // Each member it is for gets it on their own calendar (src/space-calendars.mjs), without holding this answer up.
    this.tellEventCalendars(id, ids);
    return { event_id: ids[0], ...(series ? { series_id: series, event_ids: ids } : {}) };
  },

  // The events of one space that overlap from..to, for a calendar that reads every space a person is in. A space whose
  // events this person may not see answers none, never an error, so one read can ask every space.
  async spaceEvents({ relay, community_id: id, holds = [], from = null, to = null }) {
    const community = await this.readCommunity(id);
    const member = await this.activeMember(community, relay, holds);
    if (!seesMeetings(community.config, member)) return { space_id: id, title: community.config.title, events: [] };
    const start = at(from) ?? '0000';
    const end = at(to) ?? '9999';
    const rows = (await this.memberships.events(id)).filter(row => row.parent_id === id && row.label === 'event'
      && row.starts_at < end && (row.ends_at ?? row.starts_at) >= start).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    const mayPutOn = member && rows.length ? Boolean((await this.mayIn(community, relay, ['put_on_events'])).put_on_events) : false;
    return {
      space_id: id, title: community.config.title,
      events: await Promise.all(rows.map(async row => ({
        event_id: row.id, title: row.title, about: row.about, starts_at: row.starts_at, ends_at: row.ends_at,
        you_are_going: member ? await this.isMemberNow(row.id, relay) : false,
        may_move: Boolean(member && (mayPutOn || row.created_by === relay)),
      }))),
    };
  },

  // A new time, title or words for one event, by whoever may put events on in its space or whoever put it on. A new
  // start with no new end keeps the event's length.
  async moveEvent({ relay, community_id: id, holds = [], event_id: eventId, starts_at: startsAt, ends_at: endsAt, title, about, quiet = false }) {
    const event = await this.memberships.read(eventId);
    if (!event) throw new Error('No event with that id in this space.');
    if (event.created_by === relay) await this.checkedMember(id, relay, holds);
    else await this.checkedMay(id, relay, 'put_on_events', holds);
    const starts = startsAt === undefined ? event.starts_at : at(startsAt) ?? (() => { throw new Error('starts_at is a date and time.'); })();
    const kept = event.ends_at && startsAt !== undefined ? new Date(Date.parse(starts) + Date.parse(event.ends_at) - Date.parse(event.starts_at)).toISOString() : event.ends_at;
    const ends = endsAt === undefined ? kept : endsAt === null ? null : at(endsAt) ?? (() => { throw new Error('ends_at is a date and time.'); })();
    if (ends && Date.parse(ends) < Date.parse(starts)) throw new Error('An event ends after it starts.');
    const words = about === undefined ? event.about : typeof about === 'string' && about.trim() ? about.trim().slice(0, 2000) : null;
    await this.memberships.putEvents([{ ...event, starts_at: starts, ends_at: ends, title: title === undefined ? event.title : text(title, 'A title', 200), about: words }]);
    this.spaceChanged(id);
    this.tellEventCalendars(id, [eventId]);
    if (!quiet && (starts !== event.starts_at || ends !== event.ends_at)) await this.tellMembersOfMeetingChange({ relay, space_id: id, change: 'moved', title: title ?? event.title });
    return { event_id: eventId, starts_at: starts, ends_at: ends };
  },

  // Takes a meeting off for everyone, by whoever may move it: each member's copy on their own calendar goes, and the
  // space is told who cancelled it.
  async cancelEvent({ relay, community_id: id, holds = [], event_id: eventId }) {
    const event = await this.memberships.read(eventId);
    if (!event) throw new Error('No event with that id in this space.');
    if (event.created_by === relay) await this.checkedMember(id, relay, holds);
    else await this.checkedMay(id, relay, 'put_on_events', holds);
    this.tellEventCalendars(id, [eventId], null, { cancelled: true });
    await this.memberships.removeEvent(eventId);
    this.spaceChanged(id);
    await this.tellMembersOfMeetingChange({ relay, space_id: id, change: 'cancelled', title: event.title });
    return { event_id: eventId, cancelled: true };
  },

  // Going is joining the event's membership record; not going is leaving it.
  async rsvp({ relay, event_id: eventId, holds = [], going = true }) {
    const event = await this.memberships.read(eventId);
    if (!event) throw new Error('No community event with that id.');
    await this.checkedMember(event.parent_id, relay, holds);
    const now = new Date().toISOString();
    if (!going) {
      // Kept even for someone who never said they were going, so a meeting every member of a space is put down for
      // knows who said no (src/space-calendars.mjs takes it off their calendar).
      await this.memberships.putMember({ membership_id: eventId, relay, role: 'going', state: 'left', changed_at: now });
      this.tellEventCalendars(event.parent_id, [eventId], relay);
      return { event_id: eventId, going: false };
    }
    if (!await this.isMemberNow(eventId, relay)) {
      const size = (await this.memberships.members(eventId)).filter(row => row.state === 'member').length;
      if (event.size_limit && size >= event.size_limit) throw new Error('This event is full.');
    }
    await this.memberships.putMember({ membership_id: eventId, relay, role: 'going', state: 'member', changed_at: now });
    this.tellEventCalendars(event.parent_id, [eventId], relay);
    return { event_id: eventId, going: true };
  },
  async eventFile({ event_id: eventId, relay = null, holds = [] }) {
    const event = await this.memberships.read(eventId);
    if (!event) throw new Error('No community event with that id.');
    const community = await this.readCommunity(event.parent_id);
    const member = await this.activeMember(community, relay, holds);
    if (!(community.config.spaces?.events === 'everyone' || (community.config.spaces?.events === 'members' && member))) throw new Error('Only members see these events.');
    const start = Date.parse(event.starts_at);
    return calendarInviteFile({
      uid: await this.calendarUid(event.id, community), start_ms: start, end_ms: event.ends_at ? Date.parse(event.ends_at) : start + HOUR,
      summary: event.title, description: [event.about, community.config.title].filter(Boolean).join('\n\n'),
      organizer: await this.calendarOrganizer(community),
      attendees: [], method: 'REQUEST', sequence: 0, now_ms: Date.now(), reminder_minutes: [60],
    });
  },
  };
  const mutations = new Set(['createEvent', 'moveEvent', 'cancelEvent', 'rsvp']);
  const identity = () => {
    const actor = principal();
    if (!object(actor) || actor.resource !== resource || actor.holds !== null && !Array.isArray(actor.holds)
      || !(actor.relay === null || typeof actor.relay === 'string' && actor.relay))
      throw fail('The event command has no current admitted resource principal.', 403);
    return actor;
  };
  const actions = Object.fromEntries(Object.keys(methods).map(name => [name, async (input = {}) => {
    if (!object(input)) throw new TypeError('Event input must be an object.');
    const signature = JSON.stringify(identity());
    const check = () => {
      if (JSON.stringify(identity()) !== signature) throw fail('The event command principal changed.', 403);
    };
    await current('community:' + name, input);
    check();
    const actor = identity(), changes = mutations.has(name);
    if (changes && (!actor.relay || !object(actor.actor)
      || !['account', 'person'].includes(actor.actor.kind)
      || typeof actor.actor.id !== 'string' || !actor.actor.id)) throw fail('An event change needs a disclosed native member actor.', 403);
    if (name === 'createEvent') {
      if (Number.isInteger(input.size_limit) && input.size_limit < 1) throw fail('size_limit is at least one.');
      const starts = at(input.starts_at), ends = at(input.ends_at);
      if (starts && ends && Date.parse(ends) < Date.parse(starts)) throw fail('An event ends after it starts.');
    }
    if (name === 'rsvp' && input.going !== undefined && typeof input.going !== 'boolean') throw fail('going is true or false.');

    const seen = new Map(), snapshots = new Map(), pending = [];
    const remember = row => {
      if (row) { seen.set(row.id, structuredClone(row)); snapshots.set(row.id, structuredClone(row)); }
      return structuredClone(row);
    };
    const unchanged = async id => {
      check();
      const before = seen.get(id), kept = await memberships.read(id);
      if (before && JSON.stringify(before) !== JSON.stringify(kept))
        throw fail('The event changed while its permission was checked. Read it again.', 409);
      return kept;
    };
    const membership = {
      async read(id) {
        check();
        const row = await memberships.read(id);
        if (row && row.id !== id) throw fail('The membership owner returned another event.', 409);
        // These are the original SELECT's event and parent predicates. A
        // membership of another kind or space is not this operation's event.
        if (row && (row.label !== 'event' || !row.parent_id
          || ['moveEvent', 'cancelEvent'].includes(name) && row.parent_id !== input.community_id)) return null;
        return remember(row);
      },
      async events(id) { check(); return (await memberships.events(id)).map(remember); },
      member: async (...args) => { check(); return memberships.member(...args); },
      members: async (...args) => { check(); return memberships.members(...args); },
      async putEvents(rows) {
        if (new Set(rows.map(row => row.id)).size !== rows.length)
          throw fail('An event identity is already in use.', 409);
        for (const row of rows) {
          const kept = await unchanged(row.id);
          if (!seen.has(row.id) && kept) throw fail('An event identity is already in use.', 409);
        }
        check();
        await memberships.putEvents(rows, actor.actor);
        for (const row of rows) snapshots.set(row.id, structuredClone(row));
      },
      async putMember(row) {
        await unchanged(row.membership_id);
        check(); await memberships.putMember(row, actor.actor);
      },
      async removeEvent(id) {
        await unchanged(id);
        check(); await memberships.removeEvent(id, actor.actor);
      },
    };
    const access = fn => async (...args) => {
      const granted = await fn(...args);
      check();
      const unavailable = () => Object.assign(fail('The current space owner could not verify event access.', 503), { code: 'event_access_unknown' });
      const denied = () => Object.assign(fail('The current space owner did not grant event access.', 403), { code: 'event_access_denied' });
      if (granted === true) return granted;
      if (granted === false) throw denied();
      if (!object(granted)) throw unavailable();
      const state = granted.status ?? granted.state;
      if (['unknown', 'unavailable', 'failed', 'error', 'pending', 503].includes(state)
        || granted.error != null) throw unavailable();
      if (granted.allowed === false || ['denied', 'refused', 'forbidden', 401, 403].includes(state)) throw denied();
      // The original checked methods return the community itself. A decision
      // envelope or an unrelated record is not that positive return contract.
      const config = granted.config;
      if (['allowed', 'status', 'state', 'error', 'code'].some(key => Object.hasOwn(granted, key))
        || granted.id !== args[0] || typeof granted.id !== 'string' || !granted.id
        || !object(config) || typeof config.title !== 'string' || !config.title.trim()
        || config.spaces !== undefined && (!object(config.spaces)
          || Object.values(config.spaces).some(mode => !['members', 'everyone'].includes(mode)))) throw unavailable();
      return granted;
    };
    const host = {
      memberships: membership, eventTimes,
      readCommunity: async id => { const result = await readCommunity(id); check(); return result; },
      activeMember: async (community, relay, holds) => {
        const decision = await memberDecision({ community, relay, holds, member: await membership.member(community.id, relay), acceptedInvitation })
          .catch(error => {
            throw error?.status === 503 ? Object.assign(fail('The current space owner could not verify event membership.', 503), { code: 'event_membership_unknown' }) : error;
          });
        check();
        return decision.allowed;
      },
      checkedMay: access(checkedMay),
      checkedMember: async (id, relay, holds) => {
        const community = await communityValue(id);
        check();
        return checkedMemberDecision({ community, relay, holds, member: await membership.member(id, relay), acceptedInvitation });
      },
      mayIn: async (...args) => { const result = await mayIn(...args); check(); return result; },
      isMemberNow: async (id, relay) => (await membership.member(id, relay))?.state === 'member',
      spaceChanged: (...args) => { pending.push(['spaceChanged', () => spaceChanged(...args)]); },
      tellMembersOfMeetingChange: input => { pending.push(['meetingChange', () => tellMembersOfMeetingChange(input)]); },
      tellEventCalendars(spaceId, eventIds, onlyRelay = null, options = {}) {
        const events = eventIds.map(id => {
          const event = snapshots.get(id);
          if (!event) throw fail('The current event snapshot for calendar delivery is unavailable.', 503);
          return structuredClone(event);
        });
        pending.push(['calendars', () => tellEventCalendars(spaceId, eventIds, onlyRelay, options, { resource, events })]);
      },
      calendarUid: async (...args) => {
        const uid = await calendarUid(...args);
        check();
        if (typeof uid !== 'string' || !uid.trim() || /[\r\n]/.test(uid)) throw fail('The current event calendar UID is unavailable.', 503);
        return uid;
      },
      calendarOrganizer: async community => {
        const organizer = await calendarOrganizer(community);
        check();
        if (!organizer || typeof organizer.email !== 'string' || !organizer.email.trim() || /[\r\n]/.test(organizer.email))
          throw fail('The current community calendar organizer is unavailable.', 503);
        return organizer;
      },
    };
    const run = async () => {
      const answer = await methods[name].call(host, { ...input, relay: actor.relay, holds: actor.holds });
      await current('community:' + name, input);
      check();
      return answer;
    };
    const result = changes ? await memberships.transaction(run) : await run();
    try { await current('community:' + name, input); check(); }
    catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { committed: changes, result, effect: 'admission' });
    }
    for (const [effect, deliver] of pending) {
      try { await current('community:' + name, input); check(); await deliver(); }
      catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { committed: changes, result, effect });
      }
    }
    return result;
  }]));
  const operations = Object.freeze(Object.fromEntries(Object.entries(actions).map(([name, run]) => ['community:' + name, run])));
  return Object.freeze({ ...actions, operations, invoke(operation, input = {}) {
    const run = operations[operation];
    if (!run) throw fail('The native community event operation is not installed.', 404);
    return run(input);
  } });
}

