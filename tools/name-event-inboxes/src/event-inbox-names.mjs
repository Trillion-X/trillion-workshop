// src/event-inbox-names.mjs
//
// The names event inboxes are addressed by (src/event-inbox.mjs): one inbox per notice, by its source's own event id,
// and one per source for its upkeep. Kept apart from the inbox class so the Worker can name an inbox without loading it.
//
//   noticeInboxName(key) → 'notice:{key}'      upkeepInboxName(source) → 'upkeep:{source}'
export const noticeInboxName = key => `notice:${key}`;
export const upkeepInboxName = source => `upkeep:${source}`;
