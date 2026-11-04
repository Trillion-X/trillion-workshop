// src/space-item-rules.mjs
//
// Purpose
//   The Network's side of rules about a space (src/automations.mjs, set_rule with when.space_id): which members
//   have asked to be handed a space's new items, and handing each of them every item added to or shared into it.
//   Methods of `Network` (src/network.mjs), beside the space methods in src/spaces.mjs.
//
// Non-negotiable invariants
//   1. A member is handed a space's items only while they are a member at that moment: the watch is checked against
//      current membership when it is set and again every time items are handed out, so leaving stops it at once.
//   2. What a member is handed is exactly what read_space shows that member (outwardItem): nothing from any other
//      member's private store, and a sharer's private record id only to that sharer.
//   3. Only members with a rule about the space are called, so a space of thousands costs one call per member who
//      asked, not one per member.
//   4. A member's store that cannot be reached is skipped; the item stays in the space and the add succeeds.
//
// Security
//   The member's relay is set by their own store from the signed-in account, never taken from a request. Each
//   member's store is reached by the person_ref the Network already keeps for their relay.
//

const BOUND_ITEMS = 90;

export const spaceItemRuleMethods = {
  setUpSpaceItemRules() {
    this.sql.exec('CREATE TABLE IF NOT EXISTS space_item_watchers (space_id TEXT NOT NULL, relay TEXT NOT NULL, since TEXT NOT NULL, PRIMARY KEY (space_id, relay))');
  },

  // A member's store says it has (or no longer has) a rule about this space. Starting needs membership now; stopping
  // never does, so a member who left can still remove their rule.
  async watchSpaceItems({ relay, space_id: spaceId, watching }) {
    if (!watching) {
      this.sql.exec('DELETE FROM space_item_watchers WHERE space_id = ? AND relay = ?', String(spaceId ?? ''), relay);
      return { space_id: spaceId, watching: false };
    }
    const space = await this.allowedInSpace(spaceId, relay, 'watch_items');
    this.sql.exec('INSERT OR IGNORE INTO space_item_watchers (space_id, relay, since) VALUES (?, ?, ?)', space.id, relay, new Date().toISOString());
    return { space_id: space.id, watching: true };
  },

  // The spaces a relay is a member of now, as ids (what list_rules checks a space rule against).
  async memberSpaceIds({ relay }) {
    return (await this.readableSpaces(relay)).map(row => row.id);
  },

  // Hands every current member with a rule about this space the items just added, each as they read it.
  async handSpaceItemsToWatchers(spaceId, itemIds) {
    if (!itemIds.length) return;
    const watchers = this.sql.exec(`SELECT w.relay, r.person_ref FROM space_item_watchers w
      JOIN members m ON m.membership_id = w.space_id AND m.relay = w.relay AND m.state = 'member'
      JOIN relays r ON r.relay = w.relay WHERE w.space_id = ?`, spaceId).toArray();
    if (!watchers.length) return;
    // A Durable Object's SQLite binds at most 100 values in one query, and a batch may add 100 items.
    const rows = [];
    for (let start = 0; start < itemIds.length; start += BOUND_ITEMS) {
      const page = itemIds.slice(start, start + BOUND_ITEMS);
      rows.push(...this.sql.exec(`SELECT * FROM space_items WHERE space_id = ? AND id IN (${page.map(() => '?').join(', ')}) ORDER BY added_at, id`, spaceId, ...page).toArray());
    }
    const nameOf = this.memberNames(spaceId);
    // Each watcher is handed the items exactly as the space shows them to that member (thingsAsSeenBy, the same read
    // spaceItems answers), so a rule never sees more or less than its member does.
    const space = this.sql.exec('SELECT id, label, title, about, created_by, created_at FROM memberships WHERE id = ?', spaceId).toArray()[0];
    await Promise.allSettled(watchers.map(async watcher => this.env.PERSON.get(this.env.PERSON.idFromString(watcher.person_ref))
      .spaceItemsAdded({ space_id: spaceId, items: await this.thingsAsSeenBy(space, watcher.relay, rows, nameOf) })));
  },
};
