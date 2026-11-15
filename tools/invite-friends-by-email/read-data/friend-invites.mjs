import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';


// Library only: these required owners are bound by the host, never by tool input. A missing binding fails closed.
// rowType is the native import's actual invitation row kind, supplied by that binding; no record kind is guessed.
export function friendInvites({ settings, door, rowType, normalEmail, accountsForEmail, referralSummary, referralsOf, day, offWords, sendMail }) {
  if (!door?.readRecord || !door?.list || !door?.write || typeof rowType !== 'string' || !rowType) throw new TypeError('The invitation records owner is required.');
  if (!settings?.words || !Array.isArray(settings.statuses)) throw new TypeError('Invitation policy and words must be read from the account lists.');
  const FRIEND_INVITES = settings;
  for (const owner of [normalEmail, accountsForEmail, referralSummary, referralsOf, day, offWords, sendMail]) {
    if (typeof owner !== 'function') throw new TypeError('The account, referral, display and mail owners are required.');
  }
  const inviteRows = {
    async get(id, kind) {
      const row = await door.readRecord(rowType, id);
      return row === null ? null : kind === 'json' ? row.value : JSON.stringify(row.value);
    },
    async put(id, value) { await door.write([{ id, type: rowType, value: JSON.parse(value) }]); },
    async delete(id) { await door.write([{ id, type: rowType, value: null }]); },
    async list({ prefix, limit, cursor }) {
      if (cursor && (typeof cursor !== 'string' || !cursor.startsWith(prefix))) throw new TypeError('The invitation cursor belongs to another account.');
      const keys = [];
      for await (const row of door.list({ type: rowType, prefix, fields: [] })) keys.push(row.id);
      const remaining = keys.sort().filter(id => !cursor || id > cursor);
      const page = remaining.slice(0, limit);
      return { keys: page.map(name => ({ name })), list_complete: page.length === remaining.length, cursor: page.at(-1) };
    },
  };
// src/friend-invites.mjs
//
// Purpose
//   Invite a friend by name and email from the Invite friends screen (the Marketplace screen tool:invite): Trillion
//   emails them the person's referral link (src/shares.mjs) and keeps one row per invited email so the screen can show
//   an Invites table with a status for each: Invited, Joined (an account now goes by that email) or Paying (that account
//   joined with this person's link and paid). Words, limits, the email and the statuses are DATA
//   (src/friend-invites.json); the email goes through the one sender (src/mail-sender.mjs), so its sending limits apply.
//
// Non-negotiable invariants
//   1. One row per invited email (its key holds the BLAKE3 identity of the lowercased address); inviting again updates
//      that row and sends again, it never makes a second row.
//   2. A row is kept only after the email was handed to the sender; a refused send keeps nothing and says why.
//   3. A person's invites are erased with their account (src/shares.mjs removeSharesPage), and no one else reads them.
//   4. A status is read from the account index and the person's own referral rows; nothing is guessed.
//


class FriendInviteError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const fill = (text, values) => String(text).replace(/\{(\w+)\}/g, (whole, name) => String(values[name] ?? whole));
const text = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const keyOf = (userId, email) => `${settings.fact_prefix}${userId}:${makeHashCodeHexFromBytes(new TextEncoder().encode(email)).slice(3).slice(0, 32)}`;

// The status of one invite: the first row of DATA whose condition holds for the facts read for it.
const statusOf = facts => settings.statuses.find(row => row.when === 'always' || facts[row.when]) ?? settings.statuses.at(-1);

/**
 * Emails a friend the person's link and keeps the invite. `inviter` is the name the email says it is from.
 * → { name, email, invited_at } or throws FriendInviteError in plain words.
 */
async function inviteFriend(env, userId, { name, email, inviter, own_email: ownEmail }, { now = () => new Date(), send = sendMail } = {}) {
  const friend = text(name, settings.name_max);
  if (!friend) throw new FriendInviteError(settings.words.need_name);
  const address = normalEmail(email);
  if (!address) throw new FriendInviteError(settings.words.need_email);
  if (normalEmail(ownEmail) === address) throw new FriendInviteError(settings.words.yourself);
  const key = keyOf(userId, address);
  const earlier = await inviteRows.get(key, 'json');
  if (!earlier) {
    const page = await inviteRows.list({ prefix: `${settings.fact_prefix}${userId}:`, limit: settings.max + 1 });
    if (page.keys.length >= settings.max) throw new FriendInviteError(fill(settings.words.full, { max: settings.max }));
  }
  const summary = await referralSummary(env, userId);
  const link = summary.links[0];
  if (!link) throw new FriendInviteError(settings.words.no_link);
  const words = settings.email;
  const theirs = offWords(summary.friend_gets);
  const sent = await send(env, null, {
    to: address, kind: settings.kind,
    subject: fill(words.subject, { inviter }),
    markdown: fill(words.markdown, { name: friend, inviter, reward: theirs ? fill(words.reward, { theirs }) : words.reward_none }),
    action: { label: words.action, href: link },
    footer_lines: [fill(words.footer, { inviter })],
  });
  if (!sent.sent) throw new FriendInviteError(fill(settings.words.not_sent, { why: sent.error ?? 'try again in a moment.' }));
  const row = { name: friend, email: address, invited_at: now().toISOString(), times: (earlier?.times ?? 0) + 1 };
  await inviteRows.put(key, JSON.stringify(row));
  return row;
}

/** Removes one invite from the list: → whether it was there. */
async function forgetInvite(env, userId, email) {
  const address = normalEmail(email);
  if (!address) return false;
  const key = keyOf(userId, address);
  const had = await inviteRows.get(key);
  if (had === null) return false;
  await inviteRows.delete(key);
  return true;
}

/**
 * One page of the person's invites, newest first within the page's keys, each with its status:
 * { invites: [{ name, email, invited_at, times, status: { id, label, tone } }], next }.
 * `after` is the cursor the previous page answered.
 */
async function invitesOf(env, userId, { after = null } = {}) {
  const prefix = `${settings.fact_prefix}${userId}:`;
  const page = await inviteRows.list({ prefix, limit: settings.page, ...(after ? { cursor: after } : {}) });
  const joinedWith = new Map((await referralsOf(env, userId)).map(person => [person.friend_id, person]));
  const invites = await Promise.all(page.keys.map(async ({ name }) => {
    const row = await inviteRows.get(name, 'json');
    if (!row) return null;
    const accounts = (await accountsForEmail(inviteRows, row.email)).filter(id => id !== userId);
    const status = statusOf({ joined: accounts.length > 0, paid: accounts.some(id => joinedWith.get(id)?.paid_at) });
    return { ...row, status: { id: status.id, label: status.label, tone: status.tone } };
  }));
  return { invites: invites.filter(Boolean).sort((a, b) => String(b.invited_at).localeCompare(String(a.invited_at))), next: page.list_complete ? null : page.cursor };
}

/**
 * One page of invites as the Invite friends screen draws it: a row per invite with the day it was sent and its status,
 * and the address of the page after, or null when the invites could not be read. `invites` is invitesOf's answer.
 */
function friendInviteFacts(invites) {
  if (!invites) return null;
  return {
    rows: invites.invites.map(({ name, email, invited_at: invitedAt, status }) => ({ name, email, sent_day: day(invitedAt), status })),
    next_open: invites.next ? `/invite?invites_after=${encodeURIComponent(invites.next)}` : null,
  };
}

return { FRIEND_INVITES, FriendInviteError, inviteFriend, forgetInvite, invitesOf, friendInviteFacts };
}
