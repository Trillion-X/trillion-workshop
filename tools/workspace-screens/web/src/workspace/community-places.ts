// src/workspace/community-places.ts
//
// PURPOSE
//   What a space's turned-on parts answer (`CommunityView`, read from /work/api/community), which places that answer
//   adds to the space's nav (`communityPlacesOf`) and the place an added tool opens in (`toolPlace`). The Spaces screen
//   builds its nav from this at once; the places themselves are drawn by community-screen.tsx, which the Spaces screen
//   loads only when it first draws one, so opening a space does not carry the places screen and its guide
//   (scripts/workspace-budgets.json screen_script_bytes).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here draws: only the read's shape and the places table, so importing it costs a few hundred bytes.
//   2. A place shows only when `has` finds something in the space's answer; the table is the one list of places both
//      the nav and the places screen read.

/** One place of a pursuit: what its row in the sidebar says and opens. */
export type SectionedSpacePlace = { id: string; label: string; icon?: string; badge?: string };

export type Standing = {
  measures?: Record<string, number>;
  level?: { name: string; number: number; of: number } | null;
  next_level?: { name: string; needs: number; measure: string } | null;
  rewards?: { id: string; title: string; says: string | null; needs: { measure: string; at_least: number }; have: number; claimed: number; can_claim: boolean }[];
  streak?: { label: string; periods: number; this_period: number; of: number } | null;
  counts?: Record<string, number>;
  place?: { place: number; of: number };
};
export type Post = { post_id: string; by: string; yours: boolean; body: string; at: string; votes: number; your_votes: number; why?: string[]; replies: Post[] };
export type Event = { event_id: string; title: string; about: string | null; starts_at: string; ends_at: string | null; going: number; you_are_going?: boolean; people_going?: string[] };
export type SavedLessonModule = { bundle: string; file: string; requests?: Record<string, unknown> };
export type Course = { course_id: string; title: string; about: string | null; done: number; of: number; lessons: { lesson_id: string; title: string; status: string; body: string | null; module?: SavedLessonModule | null }[] };
export type Match = { match_id: string; status: string; says: string; answered: 'yes' | null; answer_by: string | null; consent: string; with: { name: string; level: string | null }; why: string[]; topics: string[]; space_id: string | null };
export type TribeMember = { name: string; place: number; level: string | null; you: boolean; status: string | null };
export type Tribe = {
  sizes: number[]; status_name: string;
  you: { status: string | null; helps: { name: string } | null; helped_by: { name: string } | null };
  groups: { size: number; label: string; members: TribeMember[] }[];
  top_group: { label: string; members: TribeMember[] } | null;
};
export type Discovered = { name: string; level: string | null; shared: string[]; offers: string[]; seeks: string[]; connect: boolean; relay?: string };
/** One tool added to the space (src/spaces.mjs spaceAddedTools, named by src/person-spaces.mjs addedTools); `part` is a
 *  tool that switches the space's own settings (its place is the part's own, such as Leaderboard). */
export type AddedTool = { tool_id: string; label: string; about: string | null; icon: string | null; part: boolean; for_everyone: boolean; you_may_use: boolean; added_at: string; readable?: boolean };
/** A tool a search of the Marketplace found (GET /work/api/workshop/find). */
export type FoundTool = { tool_id: string; label: string; job: string | null; description: string | null };
/** One space's turned-on parts as this person may see them (src/community.mjs `community`). */
export type CommunityView = {
  community_id: string; title: string; about: string | null; members_count: number; join: string; digest_offered: boolean; mission?: string;
  /** Present for the owner or a member allowed to change community settings. */
  config?: { roles?: Record<string, { label?: string; may?: string[]; inherits?: string[] }>; [key: string]: unknown };
  member_types?: { id: string; label: string; inherits?: string[]; may?: string[]; source?: string; own: boolean }[];
  updated_at?: string;
  tools?: AddedTool[];
  may_add_tools?: boolean;
  matching?: { on: boolean; cadence_label: string; next_at: string | null; matches: Match[] };
  tribe?: Tribe;
  discover?: Discovered[];
  you: Standing & { member: boolean; owner: boolean; may_join: boolean; name?: string; role?: string; email_digest?: boolean; may?: string[] };
  levels?: { measure: string | null; bands: { name: string; from: number }[]; ways_to_earn: { kind?: string; says?: string; adds: number }[] };
  events?: Event[];
  feed?: Post[];
  courses?: Course[];
  board?: boolean;
  members?: { name: string; role: string; level: string | null; you: boolean }[];
  leaderboard?: { measure: string; places: { name: string; level: string | null; value: number; place: number; you: boolean }[] };
  claims?: { claim_id: string; by: string; reward_id: string; at: string }[];
};

// The places a space's turned-on parts add, in nav order; each shows only when `has` finds something to put there.
const PLACES: (SectionedSpacePlace & { has: (view: CommunityView) => boolean })[] = [
  { id: 'home', label: 'Home', icon: 'House', has: () => true },
  { id: 'matches', label: 'Matches', icon: 'Handshake', has: view => Boolean(view.matching) },
  { id: 'tribe', label: 'Tribe', icon: 'Crown', has: view => Boolean(view.tribe) },
  { id: 'discover', label: 'Discover', icon: 'Compass', has: view => Boolean(view.discover?.length) },
  // The space's shared board, drawn by the space screen itself (the board's own screen, parts/group/show/board-screen.tsx).
  { id: 'board', label: 'Board', icon: 'LayoutDashboard', has: view => Boolean(view.board) },
  { id: 'classroom', label: 'Classroom', icon: 'GraduationCap', has: view => Boolean(view.courses?.length) },
  { id: 'members', label: 'Members', icon: 'Users', has: view => Boolean(view.members?.length) },
  { id: 'leaderboard', label: 'Leaderboard', icon: 'Trophy', has: view => Boolean(view.leaderboard?.places.length) },
  { id: 'about', label: 'About', icon: 'Info', has: () => true },
  { id: 'tools', label: 'Tools', icon: 'Wrench', has: view => Boolean(view.tools) },
];
/** The place of the space's nav an added tool opens in, its own screen on the space (spaces-screen.tsx): the tool's id,
 *  which never meets a place of the space's own (those are plain words, a tool's id starts with `tool:`). */
export const toolPlace = (toolId: string) => toolId;

/** The places this space's turned-on parts add, in nav order, each only when it has something to show. */
export const communityPlacesOf = (view: CommunityView): SectionedSpacePlace[] => PLACES.filter(place => place.has(view)).map(({ has: _has, ...place }) => place);

/** How a turned-on place is renamed and when it shows (space-kinds.json `turned_on_places`). */
export type TurnedOn = { label?: string; icon?: string; shows_when?: { has: string; member?: boolean } | { address_has: string } };
/** One part of a pursuit beyond its own places: a turned-on place, or the screen of a tool added to it (`tool_id`). */
export type PartPlace = SectionedSpacePlace & { tool_id?: string };

/**
 * The parts one pursuit's room adds after its own places (space-kinds.json `places`, `own`), from one read of its
 * turned-on parts: each turned-on place renamed and shown as `turnedOn` says (a place that needs the page's address to
 * carry a parameter shows only when `addressHas` says it does), then the screen of every tool added there that this
 * person may use. A tool whose description can no longer be read is not a place: its raw id is never a name.
 */
export function partPlacesOf(view: CommunityView, turnedOn: Record<string, TurnedOn>, own: readonly string[], addressHas: (parameter: string) => boolean = () => false): PartPlace[] {
  const places: PartPlace[] = communityPlacesOf(view).flatMap(place => {
    const row = turnedOn[place.id] ?? {};
    const when = row.shows_when;
    if (when && 'has' in when && (view as Record<string, unknown>)[when.has] === undefined) return [];
    if (when && 'has' in when && when.member !== undefined && Boolean(view.you?.member) !== when.member) return [];
    if (when && 'address_has' in when && !addressHas(when.address_has)) return [];
    return [{ ...place, ...(row.label ? { label: row.label } : {}), ...(row.icon ? { icon: row.icon } : {}) }];
  }).filter(place => !own.includes(place.id));
  const tools = (view.tools ?? []).filter(tool => !tool.part && tool.you_may_use && tool.readable !== false && tool.label && tool.label !== tool.tool_id)
    .map(tool => ({ id: toolPlace(tool.tool_id), label: tool.label, icon: tool.icon ?? 'Wrench', tool_id: tool.tool_id }));
  return [...places, ...tools];
}
