// src/message-retention.mjs
//
// PURPOSE
//   A conversation can carry a retention policy: messages older than N days are erased. The policy is one editable row per
//   conversation (set, read, clear); the sweep that applies it runs on the store's alarm and on demand, and every erasure
//   goes through the account's one erasure owner (PersonStore.eraseRecord), so a timer never deletes by any other road.
//   Numbers and names are DATA (src/message-retention.json).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Erasure is the erasure owner's: this file reads which messages are old and hands each id to `erase`; it never
//      removes a record or its derived copies itself.
//   2. Oldest first and bounded: a sweep reads one page of a conversation's oldest messages, in id (time) order, and stops at
//      the first one inside the window; no sweep reads a whole conversation.
//   3. A policy is only what the person set: clearing it stops the sweep; messages already erased stay erased.
//   4. Nothing here names a conversation, an app or a kind of message.
import settings from './message-retention.json' with { type: 'json' };

const TYPE = 'message';
const DAY_MS = 86_400_000;

export class RetentionError extends Error {}

const keyOf = conversation => `${settings.key_prefix}${conversation}`;
const named = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new RetentionError('Say which conversation: conversation_id is its id.');
  return value.trim();
};

/**
 * eeaf   the person's record store ({ read, scan })
 * values { list(prefix) -> current values, put(entity, value) } over the account's kept facts
 * erase  async (recordId, { app }) -> { erased, also } the account's erasure owner
 */
export function makeMessageRetention({ eeaf, values, erase, now = () => Date.now() }) {
  const active = () => values.list(settings.key_prefix).filter(policy => policy && !policy.removed_at && Number.isFinite(policy.older_than_days));
  let nextAtMs = null;

  const api = {
    /** Keeps (or changes) a conversation's policy; a sweep is due at once. */
    set({ conversation_id: conversation, older_than_days: days } = {}) {
      const id = named(conversation);
      if (!Number.isInteger(days) || days < settings.min_days || days > settings.max_days) throw new RetentionError(`older_than_days is a whole number from ${settings.min_days} to ${settings.max_days}.`);
      if (!active().some(policy => policy.conversation_id === id) && active().length >= settings.max_policies) throw new RetentionError(`At most ${settings.max_policies} conversations can have a retention policy.`);
      const policy = { conversation_id: id, older_than_days: days, set_at: new Date(now()).toISOString() };
      values.put(keyOf(id), policy);
      nextAtMs = now();
      return { policy, said: `Messages in ${id} older than ${days} ${days === 1 ? 'day' : 'days'} will be erased.` };
    },
    /** The policies in force, or the one conversation's (null when it has none). */
    read({ conversation_id: conversation } = {}) {
      const all = active().sort((a, b) => (a.conversation_id < b.conversation_id ? -1 : 1));
      if (conversation === undefined || conversation === null) return { policies: all };
      return { policy: all.find(policy => policy.conversation_id === named(conversation)) ?? null };
    },
    /** Stops a conversation's policy; what was erased stays erased. */
    clear({ conversation_id: conversation } = {}) {
      const id = named(conversation);
      const had = active().find(policy => policy.conversation_id === id);
      if (!had) return { cleared: false, said: `${id} has no retention policy.` };
      values.put(keyOf(id), { ...had, removed_at: new Date(now()).toISOString() });
      return { cleared: true, said: `${id} keeps its messages again.` };
    },
    /** Erases the messages one policy (or every policy) says are past their time, a page per policy. */
    async sweep({ conversation_id: conversation } = {}) {
      const policies = conversation ? active().filter(policy => policy.conversation_id === named(conversation)) : active();
      const done = [];
      let more = false;
      for (const policy of policies) {
        const cutoff = now() - policy.older_than_days * DAY_MS;
        let erased = 0, full = false;
        for (const entry of eeaf.scan(TYPE, 'conversation_id', { equal: [policy.conversation_id], limit: settings.page })) {
          const message = eeaf.read(entry.id);
          if (!message) continue;
          if (!(Date.parse(message.at) <= cutoff)) break;
          try { await erase(entry.id, { app: settings.app }); erased += 1; } catch (error) { if (error?.code !== 'not_found') throw error; }
        }
        full = erased >= settings.page;
        more ||= full;
        done.push({ conversation_id: policy.conversation_id, erased, more: full });
      }
      nextAtMs = more ? now() : now() + settings.every_minutes * 60_000;
      return { swept: done, said: done.length ? `Erased ${done.reduce((sum, item) => sum + item.erased, 0)} messages past their time.` : 'No conversation has a retention policy.' };
    },
    /** When the store's alarm should next sweep (ms), or null while no conversation has a policy. */
    nextAt() {
      if (!active().length) return null;
      nextAtMs ??= now();
      return nextAtMs;
    },
  };
  return api;
}

/** The account actions (tool:… rows published on the Marketplace name these `invoke.action` values). */
export const messageRetentionActions = store => {
  const retention = () => {
    if (typeof store.eraseRecord !== 'function' || !store.store?.eeaf) throw new RetentionError('This account cannot erase messages from here.');
    return store.messageRetention();
  };
  return {
    'set-message-retention': async input => retention().set(input ?? {}),
    'read-message-retention': async input => retention().read(input ?? {}),
    'clear-message-retention': async input => retention().clear(input ?? {}),
    'erase-old-messages': async input => retention().sweep(input ?? {}),
  };
};

/** The store's own retention (one per store), over its kept facts and its erasure owner. */
export const messageRetentionMethods = {
  messageRetention() {
    return this.messageRetentionKept ??= makeMessageRetention({
      eeaf: this.store.eeaf,
      values: { list: prefix => this.workshopValues(prefix), put: (entity, value) => { this.addWorkshopValue(entity, value); } },
      erase: async (id, how) => {
        const answer = await this.eraseRecord(id, how);
        this.forgetLinkPreviews([answer.erased, ...(answer.also ?? [])]);
        return answer;
      },
    });
  },
};
