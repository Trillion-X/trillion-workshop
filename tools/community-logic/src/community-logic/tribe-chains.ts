// src/community-logic/tribe-chains.ts
//
// PURPOSE
//   A community's tribes: its ranked members split into groups that double (or grow by any factor) in size, each group
//   a chain ordered top first, where every person helps the one just below them and is helped by the one just above.
//   Brian, 2026-09-28: "basically put you into teams or groups of different levels. It's like two, then four, then
//   eight, then 16, then 32... Any people in the middle, it's like a chain... they can help the person below them."
//   And for the top of a group: "I guess you make them a wizard, or a grand master... or a unicorn status... put the
//   unicorns all in a group, they could probably help each other." Sizes, labels, the status name and which group size
//   earns it are the community's DATA (its `tribe` settings); nothing here names a size or a status.
//
// HOW MEMBERS ARE SPLIT, AND WHY
//   Top down, one size at a time, largest first. The whole community is split into groups of the largest size; each of
//   those is split into groups of the next size down; and so on to the smallest. Because every group is made only by
//   splitting its parent, the groups NEST by construction: a group of 4 is made of groups of 2 (two of them whenever the
//   count allows), never of people drawn from elsewhere.
//
//   Each split deals the parent's members, in rank order, into its children like dealing cards: 1 2 1 2 ... So each
//   child takes every second (or third, ...) person of its parent, and after every split a group is people spread
//   evenly across its parent's whole range: in 32 people the pairs are 1 and 17, 9 and 25, 5 and 21, and so on. Every
//   chain therefore has a real top and a real bottom with the same distance between each step, which is what makes
//   "help the person below you" mean something at every size. Dealing in blocks (the top 2 together, the next 2
//   together) would pair equals, and a chain of equals has nobody to learn from; a snake draft (1 2 2 1) balances the
//   groups' strength instead, but pairs the two middle people with each other (16 and 17 of 32), which is the same
//   failure in the middle of the community. Siblings stay within one person of each other in size.
//
//   Counts that do not fit: a parent of n people splits into round(n / size) children (at least one), and never into
//   more than n / 2 of them, so nobody is ever alone in a group: 3 people at a size of 2 are one group of 3, and
//   33 people at a size of 32 are one group of 33, not a 32 and a person on their own. A group's label is the DATA label
//   of the size it was made at; its actual count is its member list.
//
// STATUS AND THE TOP GROUP
//   The top person of every group at the `status_at` size (DATA; the largest size when omitted) holds the status
//   (`status_name`, DATA). Because dealing puts the strongest of each parent at the top of a different child, those tops are the
//   strongest people across the community, and together, in rank order, they are the top group: the unicorns grouped so
//   they can help each other. A top group of one person is no group, so it is null below two.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure and total: no I/O, no clock, no randomness. The same members in the same order give the same groups.
//   2. The input order IS the ranking (the leaderboard's order, src/community.mjs leaderboardOf). People sharing a
//      place keep that order; this never re-sorts by name, id or anything else.
//   3. Every member is in exactly one group at every size, groups nest, and no group has fewer than two people unless
//      the whole community has fewer than two.
//   4. Sizes are DATA: each must be a whole number of at least 2 and each must divide the next, so the nesting is exact.

/** One ranked member, in leaderboard order. `id` is opaque to this function. */
export interface RankedMember {
  id: string;
}

/** The community's `tribe` settings (DATA). */
export interface TribeSettings {
  groups: ReadonlyArray<{ size: number; label: string }>;
  status_name: string;
  status_at?: number;
  top_group_label: string;
}

/** Every group made at one size, each an ordered chain of member ids, top first. */
export interface TribeLevel {
  size: number;
  label: string;
  groups: string[][];
}

/** One member's place in the tribes. */
export interface TribeSeat {
  /** The status name when this member tops a group at the status size, else null. */
  status: string | null;
  /** The next person below them in their largest group's chain, whom they help. */
  helps: string | null;
  /** The next person above them in that chain, who helps them. */
  helped_by: string | null;
  /** Their group at each size, largest first; the same people at several sizes are listed once, under the size nearest their count. */
  groups: Array<{ size: number; label: string; members: string[] }>;
}

export interface Tribes {
  levels: TribeLevel[];
  holders: string[];
  top_group: { label: string; members: string[] } | null;
  seats: Record<string, TribeSeat>;
}

/** Problems with `tribe` settings, as plain sentences (empty when they can be used). */
export function tribeProblems(settings: unknown): string[] {
  if (settings === undefined) return [];
  const tribe = settings as Partial<TribeSettings> | null;
  if (!tribe || typeof tribe !== 'object') return ['tribe is an object with groups, status_name and top_group_label.'];
  const problems: string[] = [];
  const groups = Array.isArray(tribe.groups) ? tribe.groups : [];
  if (!groups.length) problems.push('tribe.groups lists group sizes: rows of { "size": 2, "label": "Pair" }.');
  const sizes = groups.map(row => row?.size);
  if (sizes.some(size => !Number.isInteger(size) || (size as number) < 2)) problems.push('Each tribe group size is a whole number of at least 2.');
  if (groups.some(row => typeof row?.label !== 'string' || !row.label.trim())) problems.push('Each tribe group has a label.');
  for (let i = 1; i < sizes.length; i += 1) {
    const [small, big] = [sizes[i - 1] as number, sizes[i] as number];
    if (!(big > small) || big % small !== 0) problems.push(`Tribe sizes go up and each divides the next, so groups nest: ${big} is not a whole number of ${small}s.`);
  }
  if (typeof tribe.status_name !== 'string' || !tribe.status_name.trim()) problems.push('tribe.status_name names what the top of a group is called.');
  if (typeof tribe.top_group_label !== 'string' || !tribe.top_group_label.trim()) problems.push('tribe.top_group_label names the group the tops are in together.');
  if (tribe.status_at !== undefined && !sizes.includes(tribe.status_at)) problems.push('tribe.status_at is one of the group sizes.');
  return problems;
}

/** Deal `members` (rank order) into `count` children in turn, each child keeping rank order. */
function deal(members: string[], count: number): string[][] {
  const children: string[][] = Array.from({ length: count }, () => []);
  members.forEach((id, index) => children[index % count].push(id));
  return children;
}

/** How many groups of `size` a parent of `n` people makes: the nearest count, at least one, never a person alone. */
const childCount = (n: number, size: number) => Math.max(1, Math.min(Math.round(n / size), Math.floor(n / 2)));

/**
 * Every member's groups at every size, the chain links, the status holders and the top group.
 * `members` must be in leaderboard order, strongest first.
 */
export function tribeChains(members: ReadonlyArray<RankedMember>, settings: TribeSettings): Tribes {
  const sizes = [...settings.groups].sort((a, b) => b.size - a.size);
  const statusAt = settings.status_at ?? sizes[0]?.size;
  const ids = members.map(member => member.id);
  const levels: TribeLevel[] = [];
  let parents: string[][] = ids.length ? [ids] : [];
  for (const { size, label } of sizes) {
    const groups = parents.flatMap(parent => deal(parent, childCount(parent.length, size)));
    levels.push({ size, label, groups });
    parents = groups;
  }
  const statusLevel = levels.find(level => level.size === statusAt);
  const holders = (statusLevel?.groups ?? []).map(group => group[0]).filter(Boolean);
  // The holders together, in the community's rank order.
  const rankOf = new Map(ids.map((id, index) => [id, index]));
  const top = [...holders].sort((a, b) => (rankOf.get(a) as number) - (rankOf.get(b) as number));
  const holding = new Set(holders);

  const seats: Record<string, TribeSeat> = {};
  for (const id of ids) seats[id] = { status: holding.has(id) ? settings.status_name : null, helps: null, helped_by: null, groups: [] };
  for (const level of levels) for (const group of level.groups) for (const id of group) {
    const seat = seats[id];
    const above = seat.groups[seat.groups.length - 1];
    // The same people as the group above (a small community is one group at several sizes) are listed once, under
    // whichever of those sizes is nearest their count (the larger on a tie: three people are a four short of one, not
    // a pair and a spare).
    if (above && above.members.length === group.length) {
      if (Math.abs(level.size - group.length) < Math.abs(above.size - group.length)) Object.assign(above, { size: level.size, label: level.label });
      continue;
    }
    seat.groups.push({ size: level.size, label: level.label, members: group });
  }
  // The chain a person helps along is their largest group: the one with the most people above and below them.
  for (const id of ids) {
    const chain = seats[id].groups[0]?.members ?? [];
    const at = chain.indexOf(id);
    seats[id].helps = chain[at + 1] ?? null;
    seats[id].helped_by = at > 0 ? chain[at - 1] : null;
  }
  return { levels, holders: top, top_group: top.length >= 2 ? { label: settings.top_group_label, members: top } : null, seats };
}
