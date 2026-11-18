// The event and RSVP rules, as values. An event is a space's membership row with label "event"; an RSVP is that event's
// member row. These functions read no store and write none: they take the rows the caller read, and return the rows the
// caller must write, with the revision each must still have (workflow:keep-community-events-and-rsvps keeps them in the
// person's own store, in one batch with a compare-and-swap on revision).

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
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
const nextRevision = row => (row && Number.isSafeInteger(row.revision) ? row.revision + 1 : 1);

/** One event row per time (a repeating event shares its series id). Each row is new: expected null. */
export function eventRowsFor({ communityId, relay, title, about = null, sizeLimit = null, times, ids, seriesId = null, now }) {
  return times.map((time, index) => ({
    type: 'space-membership', id: ids[index], expected: null,
    value: { id: ids[index], label: 'event', title: text(title, 'A title', 200), about: typeof about === 'string' ? about.trim().slice(0, 2000) : null,
      starts_at: time.starts_at, ends_at: time.ends_at, size_limit: Number.isInteger(sizeLimit) ? sizeLimit : null,
      created_by: relay, created_at: now, parent_id: communityId, series_id: seriesId, revision: 1 },
  }));
}

/** A new time, title or words for one event: a new start with no new end keeps the event's length. Returns the row write. */
export function moveEventRow({ event, input }) {
  const startsAt = input.starts_at, endsAt = input.ends_at, { title, about } = input;
  const starts = startsAt === undefined ? event.starts_at : (at(startsAt) ?? (() => { throw new Error('starts_at is a date and time.'); })());
  const kept = event.ends_at && startsAt !== undefined ? new Date(Date.parse(starts) + Date.parse(event.ends_at) - Date.parse(event.starts_at)).toISOString() : event.ends_at;
  const ends = endsAt === undefined ? kept : endsAt === null ? null : (at(endsAt) ?? (() => { throw new Error('ends_at is a date and time.'); })());
  if (ends && Date.parse(ends) < Date.parse(starts)) throw new Error('An event ends after it starts.');
  const words = about === undefined ? event.about : typeof about === 'string' && about.trim() ? about.trim().slice(0, 2000) : null;
  const value = { ...event, starts_at: starts, ends_at: ends, title: title === undefined ? event.title : text(title, 'A title', 200), about: words, revision: nextRevision(event) };
  return { write: { type: 'space-membership', id: event.id, value, expected: { revision: event.revision ?? null } }, starts_at: starts, ends_at: ends };
}

/** Takes an event off with every RSVP it has: one batch. Refuses before any write when the batch is over the write limit. */
export function cancelEventWrites({ event, members, maxWrites }) {
  const writes = [{ type: 'space-membership', id: event.id, value: null, expected: { revision: event.revision ?? null } },
    ...members.map(member => ({ type: 'space-member', id: member.id, value: null, expected: { revision: member.revision ?? null } }))];
  if (writes.length > maxWrites) throw Object.assign(new Error('This event and its RSVPs are more than one batch can remove.'), { status: 503, code: 'community_collection_limit' });
  return writes;
}

/**
 * Going is a member row in state member; not going is state left (kept, so the space knows who said no). Going is
 * refused when the event is full and this person is not already in it. The event's revision changes in the same batch.
 */
export function rsvpWrites({ event, member, members, relay, going, now }) {
  const eventRevision = { type: 'space-membership', id: event.id, value: { ...event, revision: nextRevision(event) }, expected: { revision: event.revision ?? null } };
  if (!going) {
    return [eventRevision, { type: 'space-member', id: `${event.id}:${relay}`, expected: member ? { revision: member.revision ?? null } : null,
      value: { membership_id: event.id, relay, role: 'going', state: 'left', changed_at: now, revision: nextRevision(member) } }];
  }
  const already = member?.state === 'member';
  if (!already && event.size_limit && members.filter(row => row.state === 'member').length >= event.size_limit) throw fail('This event is full.');
  return [eventRevision, { type: 'space-member', id: `${event.id}:${relay}`, expected: member ? { revision: member.revision ?? null } : null,
    value: { membership_id: event.id, relay, role: 'going', state: 'member', changed_at: now, revision: nextRevision(member) } }];
}

/**
 * The events of one space that overlap from..to, in start order, for one person. A person who may not see the space's
 * meetings gets none. `going` is whether this person's member row is in state member for the event.
 */
export function spaceEventsView({ community, events, from, to, member, relay, seesMeetings, mayPutOn, goingIds }) {
  if (!seesMeetings) return { space_id: community.id, title: community.config.title, events: [] };
  const start = from ?? '0000';
  const end = to ?? '9999';
  const rows = events.filter(row => row.parent_id === community.id && row.label === 'event'
    && row.starts_at < end && (row.ends_at ?? row.starts_at) >= start).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  return {
    space_id: community.id, title: community.config.title,
    events: rows.map(row => ({
      event_id: row.id, title: row.title, about: row.about, starts_at: row.starts_at, ends_at: row.ends_at,
      you_are_going: member ? goingIds.has(row.id) : false,
      may_move: Boolean(member && (mayPutOn || row.created_by === relay)),
    })),
  };
}
