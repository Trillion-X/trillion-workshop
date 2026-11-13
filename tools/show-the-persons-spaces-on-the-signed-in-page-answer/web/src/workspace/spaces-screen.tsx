// src/workspace/spaces-screen.tsx
//
// PURPOSE
//   Spaces in the signed-in workspace: everything a space holds or lets a person do, reachable from the
//   screen without an AI, laid out after Basecamp's project home, Dropbox Dash stacks, Tana's team hub and chat, and
//   Telegram's channel (the screen contract in the shared-spaces plan names each Mobbin screen). Two screens:
//   - Spaces (entry `spaces`): the heading with an info icon holding what a space is (no line of text
//     under it) and New project; invitations waiting for an answer as cards with Join and Decline; then every space
//     the person is in as a card after Dropbox Dash stacks: its picture across the top with its kind's icon over the
//     edge (no kind chip), its own words, what it holds by kind, who is in it by name and when something last
//     happened, each fact shown only once the store answers it. Pressing a card opens the space in its own tab; its ⋯
//     menu holds the card's actions (open, copy its link, archive, leave). Archived lists the spaces the person archived
//     from their own list, each with Put back (src/person-spaces.mjs: only their own list changes).
//     Nothing on the page is separated by a rule; space and grouping do that.
//   - Space (entry `space`, one per tab, its id and the place it shows in the tab's input): a header with its kind,
//     title, about line, the people in it and its actions; then the one place the tab is on. The places are rows of the
//     person's one sidebar, under the pursuit's own row (pursuit-navigation-rows.mjs, pursuit-parts.ts); this screen
//     draws no navigation of its own, and a press that goes to another place opens that place as its own screen:
//       Conversation: the feed, newest at the bottom, with the box to write under it. A message is a post; anything
//         else someone shared is a card inside their post (a pursuit, a decision, a file, a kind nobody named yet).
//         Replies nest under what they answer; Show older reads the next page.
//       Everything: every thing in it in the shared record views (table, cards, board, timeline; search, filter,
//         sort and group by kind, who put it there, where it came from, and when). A shared file opens in place.
//       People: who is in it by the name each shows there and their type (a menu for whoever may give people their
//         type); your own row changes your name.
//       Who can do what: the space's rules, each a sentence built in the shared rule builder (parts/ui/show/
//         rule-builder) from what the store lists; read-only for anyone the rules do not let change them.
//       Agents & work: the agents at work there and the work handed to them; hand a job to one, or to whoever takes
//         it first.
//   The list of pursuits is the person's pursuit records, read through the records door (records-door.ts), the read
//   the sidebar's pursuit rows and their AI's key take. Every other read and write goes through /work/api/spaces
//   (src/work-spaces.mjs) to the person's own store, the same road their AI takes (src/person-spaces.mjs).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only real rows: every space, person, thing, agent and job is one the store answered. Nothing is invented while
//      loading (the shared loading rows show), and an empty place says so in words.
//   2. What each kind of thing looks like is DATA (space-kinds.json), and a kind nobody named still draws with its own
//      word made readable. What a person can do is DATA (space-actions.json): each action names where it shows, what
//      it asks for, what it confirms and the road it takes. This file runs any action the same way and never branches
//      on which action it is; a new action is a row there and no code here.
//   3. Sharing uses the same owner for one thing or an ordered mixed selection. Uploaded attachments go as one
//      checked selection, with references to their stored bytes, before the message names their pursuit items.
//   4. What is offered is what the space's own rules let this person do, as the store answers it (`space.may` and each
//      thing's `may`, read by the actions' own `when`): take back, hide or show a thing, write, describe, invite. A
//      withdrawn thing stays as a quiet line saying who took it back; a hidden one says who hid it to everyone the
//      rules do not let show it again.
//   5. Members are shown only by the name they show in the space; no contact details are read here. The screen holds
//      no permission logic: the road's allowlist and the store decide.
//   6. A space of a billion things reads one page at a time (`before`), and every list draws only what is on screen
//      (the record views' windowing).
//   7. Every control is a shared component (collection header, info hint, listing cards, thread, ask bar, command palette, record views, guide,
//      floating panel, file preview, empty and loading states, notifications); this file writes no markup and no
//      appearance.
//   8. Screen words are plain: nothing here shows the store's own vocabulary to the person.

import { quietHold } from './quiet-send-check';
import * as React from 'react';
import { readSpaceListPage, readSpaceTargetPage, reconcileLoadedSpaceItems, spacePageKey } from './space-target-page.mjs';
import type { ThreadAction, ThreadPost } from '../../parts/ui/show/coss/thread';
import { Composer, type ComposerDraft } from '../../parts/ui/show/composer';
import type { Ref as Mention } from '../../parts/ui/show/mention-field';
import { RecordChipProvider, keptMentions } from '../../parts/ui/show/record-chip';
import { useMentionChips, useMentions } from './mentions';
import { CommandPalette, type CommandPaletteItem } from '../../parts/ui/show/command-palette';
import { CollectionHeader } from '../../parts/ui/show/collection-header';
import { relativeWhen } from '../../parts/ui/show/relative-time/relative-time';
import type { GuideAction, GuideDescription, GuideReveal, GuideRow } from '../../parts/ui/show/coss/guide';
import { FloatingPanel } from '../../parts/screen-arrangement/show/FloatingPanel';
import { mountRecordViews, RecordViews, type BulkAction, type FieldDescriptor, type RecordView, type RecordViewsOptions } from '../../parts/ui/show/record-views/record-views';
import { viewsOfferedToEveryList } from '../../parts/ui/show/record-views/every-list-views';
import { notify } from '../../parts/ui/show/coss/notifications';
import { loadScreen, mountScreenState, ScreenState } from '../../parts/ui/show/screen-state';
import { mountReactSurface } from '../../parts/ui/show/react-surface-mount';
import { copyTextToClipboard } from '../../../../ui/show/clipboard/copy-text.ts';
import type { MediaPreviewProps } from '../../parts/ui/show/media-preview';
import { ActionMenu, type ActionMenuItem } from '../../parts/ui/show/action-menu';
import { ColorDot } from '../../parts/ui/show/color-dot/ColorDot';
import { Button, Container, NamedIcon, PersonTag, Text } from '../../parts/ui';
import { ListingGrid, type Listing } from '../../parts/ui/show/listing-card';
import { PLACEABLE_SURFACE_MIME } from '../../parts/ui/show/placeable-surface-intent/placeable-surface-intent';
import { addMember, emptyGraph, ensureGroup } from '../../../../turn-frames-into-slides/read-data/group-graph.ts';
import timelineLevels from '../../parts/ui/show/record-views/timeline-zoom-levels.json';
import ruleOperators from '../../../../formula-engine/rules/rule-operators.json';
import type { RuleBuilderFact, RuleBuilderOption, RuleBuilderProblem, RuleBuilderRule, RuleBuilderWhoKind } from '../../parts/ui/show/rule-builder';
import { later, lazyPart } from '../../parts/ui/show/load-later/later';
import { contentTypeOf, familyOf, filePicture, previewFor } from './file-picture';
import { mediaPreviewContent } from '../../parts/ui/show/media-preview';
import spaceKinds from './space-kinds.json';
import spaceActions from './space-actions.json';
import surfaces from './screens.mjs';
import { itemAddressOf, replaceWorkspaceAddress } from './addresses.mjs';
import { onStoreChange } from './store-changes';
import { sharedRecordReferencePage } from '../shared-record-references.mjs';
import { SharedRecordPreview } from './shared-record-preview';
import spaceSettings from '../space-settings.json';
import reactionChoices from '../reactions.json';
import type { Reaction } from '../../parts/ui/show/reactions/ReactionRow';
import { recordFilter } from './record-filter';
import { focusOn } from './scope-focus';
import { PlanNeeded, postJson, postJsonByKey, putJson, readAnswer, readJson, readListing } from './api';
import { sendQuietly } from './quiet-writes';
import { mountSpacesPlanGate } from './spaces-plan-gate';
import { askFor, failedState, planState } from './failure';
import { keepFiles, readPastedLink, wordsWithLinks } from './send-message';
import { shareKeptFiles } from './share-kept-files.mjs';
import { queuedJobDone, queuedJobLabel, sendQueuedJob } from './queue-job';
import { partPlacesOf, type CommunityView, type TurnedOn } from './community-places';
import { rememberParts } from './pursuit-parts';
import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
import { parseSpaceInviteEmails } from './space-create-recipients.mjs';
import { offerWalkthroughDefinitions } from '../../parts/guided-overlay/show/walkthrough-events';
import { registerShowSpaceMembership } from '../../parts/ui/show/show-rules/show-of';
import { listRecords, type StoredRecord } from './records-door';
import homeRecords from './home-records.json';

// The rules editor opens only on the rules tab, so it loads then.
const RuleBuilder = later(() => import('../../parts/ui/show/rule-builder'), module => module.RuleBuilder);
// The player for an opened file is fetched when a file is first opened here, so the screen opens without it.
const OpenedSharedRecord = lazyPart(() => import('./opened-shared-record'), module => module.OpenedSharedRecord);
// The shared guide draws only the panel an action that asks for fields opens, so it loads when that panel first opens.
const Guide = lazyPart(() => import('../../parts/ui/show/coss/guide'), module => module.Guide);
// The turned-on places (community-screen.tsx) load when a space first draws one: the sidebar reads community-places.ts
// at once, and a space opened only for its conversation never carries the places screen (scripts/workspace-budgets.json).
type PlaceOptions = Parameters<typeof import('./community-screen').mountCommunityPlace>[1];
function mountCommunityPlace(element: HTMLElement, options: PlaceOptions): () => void {
  let unmount: (() => void) | null = null;
  let gone = false;
  import('./community-screen').then(
    module => { if (!gone) unmount = module.mountCommunityPlace(element, options); },
    error => { if (!gone) notify(errorWords(error), { kind: 'error' }); },
  );
  return () => { gone = true; unmount?.(); };
}

// ---------------------------------------------------------------------------------------------------------------
// What the store answers (src/spaces.mjs through src/work-spaces.mjs).

/** A space's picture: one file a member chose; its bytes are read from `<space>/picture`. */
type Picture = { item_id: string; name: string; media_type: string | null; byte_length: number | null; shared_by: string };
/** What the store says about a space wherever it is listed or opened. */
type SpaceFacts = {
  space_id: string; label: string; title: string; description: string | null; picture: Picture | null; colour: string | null; member_names: string[];
  items: number; items_by_kind: Record<string, number>; unread: number; seen_at: string | null; last_activity_at: string | null;
};
type SpaceSummary = SpaceFacts & { members: number };
type Invitation = { request_id: string; why: string | null; asked_at: string; space: { title: string | null; label: string | null } };
type Member = { member_id: string; name: string; role: string; you: boolean };
/** A kind of member in a space (src/space-member-types.json, or one the space added). */
type MemberType = { id: string; label: string; about?: string; inherits?: string[]; may?: string[]; source?: string; own: boolean };
type Agent = { agent_id: string; name: string; description: string; member: string; takes_work: boolean };
type Space = SpaceFacts & { members: Member[]; agents: Agent[]; may: Record<string, boolean>; member_types: MemberType[]; joins_as?: string | null };
type Invite = { invite_id: string; made_at: string; expires_at: string; state: string; used_at: string | null; revoked_at: string | null };
// Who can do what in a space (src/space-permissions.mjs, src/space-permission-rules.json): the rules, what a rule may
// name (kinds of who, actions, facts with their values, members, member types) and whether this person may change them.
type Fact = { id: string; label: string; kind: string; values?: RuleBuilderOption[]; values_from?: string };
type Rules = {
  rules: RuleBuilderRule[]; may_change: boolean; as_started: boolean; changed_at: string; broken?: string;
  who_kinds: { kind: string; label: string; needs: string | null }[]; actions: { id: string; label: string }[]; facts: Fact[];
  members: { member_id: string; name: string; member_type: string }[]; member_types: MemberType[];
};
type JoinOffer = { space: { title: string; label: string; description: string | null; colour?: string | null; members: number }; expires_at: string; already_member?: boolean };
type Item = {
  item_id: string; kind: string; title: string | null; body: unknown; about?: string[]; reply_to?: string | null;
  provenance: { origin: string; by: string; by_you: boolean; added_at: string; your_private_record?: string };
  withdrawn?: { by: string; at: string };
  /** Hidden from the space's lists; its words come only to whoever may show it again. */
  hidden?: { by: string; at: string };
  /** What this person may do to it, as the space's rules answer (src/space-member-types.mjs). */
  may?: Record<string, boolean>;
  /** The votes on it, when anyone voted, and every other reaction given to it (src/spaces.mjs withReactions). */
  votes?: { count: number; yours: number };
  reactions?: Reaction[];
  /** The piece of what it replies to that it is about (src/responses.mjs): `quote` holds the words of a text range. */
  part?: { kind: string; quote?: string };
  /** Small facts any member may set on it (src/spaces.mjs setSpaceItemFacts): who has it, whether it is done. */
  facts?: Record<string, string | number | boolean>;
};
type Page = { items: Item[]; next_before: string | null };
type Handoff = { handoff_id: string; state: string; job: string; to_agent: string | null; taken_by: string | null; handed_at: string; finished_at?: string | null; summary?: string | null };
type Shareable = { kind: string; record_id: string; title: string | null; detail: string | null; at: string | null };
type Listed = { name: string; identity: string | null; modified_at_ms: number | null };
/** One page of a folder in the person's files, as the picker reads it. */
type FolderPage = { names: Listed[]; folders: string[]; next_after: string | null };

// ---------------------------------------------------------------------------------------------------------------
// The DATA this screen runs: kinds (space-kinds.json) and actions (space-actions.json).

type Ref = { read: { from: string; key: string[] } };
type Words = (string | Ref)[];
type Condition = Ref & ({ is: unknown } | { is_not: unknown });
type Field = { name: string; label: string; placeholder?: string; kind?: 'text' | 'choice' | 'pick'; optional?: boolean; value?: string; values?: string[]; value_from?: Ref; values_from?: Ref; options_from?: Ref; exclude_value_from?: Ref; add_label?: string; options?: { value: string; label: string }[] };
type Box = { kind: string; source?: string; body?: Words; fields?: Field[]; chip?: Words; placeholder?: Words };
type Road = { kind: string; at?: string; path?: (string | Ref)[]; body?: unknown; members_from?: Ref; pages?: { cursor: string[]; field: string }; words?: Words; verb?: string; method?: 'POST' | 'PUT'; community_role?: 'add' | 'update' | 'remove'; job?: string; context?: Record<string, Ref> };
/** One row of a space settings list an action chooses among (space-actions.json `choices`). */
type Choice = { id: string; label: string };
type Choices = { from: string[]; swatches?: boolean; current?: Ref };
type SpaceAction = {
  id: string; label: string; icon: string; tone?: string; primary?: boolean; shows: string[]; when?: Condition[];
  box?: Box; choices?: Choices; confirm?: Words; road: Road; reveal?: { label: Words; value: Ref }; copy?: Words; done?: Words; after?: string;
};
type KindLook = { label: string; plural?: string; icon: string; tone: string; draws_as: string; posted_as: string; preview: string; opens: string };
type Look = { label: string; icon?: string; tone: string };
/** Everything an action's words and road can read, by context name (space-actions.json `about`). */
type Context = Record<string, unknown>;

// An action whose road asks the person's own AIs for a job takes its label and its done words from that job's row
// (src/queued-work.json), so the words are written once.
const ACTIONS = (spaceActions.actions as unknown as SpaceAction[]).map(action => (action.road.kind === 'queue' && action.road.job
  ? { ...action, label: queuedJobLabel(action.road.job) ?? action.label, done: [queuedJobDone] }
  : action));
const KINDS = spaceKinds.kinds as Record<string, Partial<KindLook>>;
const BODY_WORDS = spaceKinds.body_words as Record<string, string | null>;
// The body fields that, when a thing carries one, name who wrote it (space-kinds.json `written_by`).
const WRITTEN_BY = spaceKinds.written_by as string[];
// The facts any member may set on any thing (space-kinds.json `item_facts`), each a field of the list of things.
const ITEM_FACTS = spaceKinds.item_facts as { id: string; label: string; icon: string; role?: string; values?: Record<string, { label: string; tone?: string }> }[];
const SPACE_LOOKS = spaceKinds.spaces as Record<string, Look>;
const ORIGINS = spaceKinds.origins as Record<string, string>;
const WORK_STATES = spaceKinds.work_states as Record<string, Look>;
const INVITE_STATES = spaceKinds.invite_states as Record<string, Look>;
const RULE_EFFECTS = spaceKinds.rule_effects as Record<string, Look & { icon: string }>;
type ListPlace = { id: string; label: string; icon: string; count?: string; screen?: string; views?: { id: string; label?: string; icon?: string }[]; kinds?: string[]; compose?: boolean; remember_as?: string; empty?: string };
const PLACES = spaceKinds.places as ListPlace[];
const TURNED_ON = spaceKinds.turned_on_places as Record<string, TurnedOn>;

const API = '/work/api/spaces';
// The page's read of every space's turned-on parts (src/work-community.mjs): the list, and one space's.
const OPEN_TO_YOU = '/work/api/community';
const turnedOnAt = (id: string) => `${OPEN_TO_YOU}/${encodeURIComponent(id)}`;
const at = (id: string) => `${API}/${encodeURIComponent(id)}`;
const readable = (word: string) => word.charAt(0).toUpperCase() + word.slice(1).replace(/[-_]+/g, ' ');
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const dateText = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const when = (iso: string | null | undefined) => (iso ? relativeWhen(iso) : '');
const shows = (place: string) => ACTIONS.filter(action => action.shows.includes(place));

const kindOf = (kind: string): KindLook => ({ ...spaceKinds.default, label: readable(kind), ...KINDS[kind] } as KindLook);
/** The kinds a pursuit's own tours are kept as (space-kinds.json draws_as `tour`). */
const TOUR_KINDS = Object.entries(KINDS).filter(([, look]) => look.draws_as === 'tour').map(([kind]) => kind);
// A pursuit's room carries no label (only a title), so it reads as a pursuit rather than failing to draw.
const spaceLook = (label: string | null): Look => SPACE_LOOKS[label ?? 'pursuit'] ?? { label: readable(label ?? 'pursuit'), tone: 'neutral' };

// The places a space's turned-on parts and added tools add after its own (community-places.ts partPlacesOf, the same
// list the sidebar shows under the pursuit): a place that needs the page's address to carry a parameter (About, opened
// by a hand-over link) shows only when this space's own address carries it.
const addressHas = (id: string, parameter: string) => location.pathname === itemAddressOf(surfaces, 'trillion.space', id) && new URLSearchParams(location.search).has(parameter);
const OWN_PLACES = PLACES.map(place => place.id);
const partPlaces = (id: string, view: CommunityView | null) => (view ? partPlacesOf(view, TURNED_ON, OWN_PLACES, parameter => addressHas(id, parameter)) : []);
/** Opens one place of a pursuit as its own screen, the way its row in the sidebar does. */
const openPlace = (id: string, title: string, place: string, item?: string) => window.dispatchEvent(new CustomEvent(PLACEABLE_SURFACE_MIME, {
  cancelable: true, detail: { id: 'trillion.space', title, surfaceInput: { id, place, ...(item ? { item } : {}) } },
}));
// The place someone not in a space sees: its feed (or how to join, when it has none) beside where to join.
const OUTSIDE_PLACE = 'home';
/** Where a space opens: the turned-on place its address asks for (a hand-over link opens About), else Conversation. */
const openingPlace = (id: string) => Object.entries(TURNED_ON).find(([, row]) => row.shows_when && 'address_has' in row.shows_when && addressHas(id, row.shows_when.address_has))?.[0] ?? 'conversation';

// ---------------------------------------------------------------------------------------------------------------
// Reading an action's DATA: values, words, conditions.

const isRef = (value: unknown): value is Ref => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && 'read' in (value as object);
function readRef(ref: Ref, context: Context): unknown {
  let value: unknown = context[ref.read.from];
  for (const key of ref.read.key) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  return value;
}
/** A body or path with every value read in; a value read from nothing is left out, and a written null stays (it
 *  clears what it names). */
function fill(value: unknown, context: Context): unknown {
  if (isRef(value)) return readRef(value, context) ?? undefined;
  if (Array.isArray(value)) return value.map(part => fill(part, context));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, part]) => [key, fill(part, context)]).filter(([, part]) => part !== undefined));
  return value;
}
const words = (list: Words | undefined, context: Context) => (list ?? []).map(part => (typeof part === 'string' ? part : String(readRef(part, context) ?? ''))).join('');
// `is` holds when the value read is the one named, `is_not` when it is anything else; null in either means absent.
const matches = (value: unknown, wanted: unknown) => (wanted === null ? value === undefined || value === null : value === wanted);
const offered = (action: SpaceAction, context: Context) => (action.when ?? []).every(condition => {
  const value = readRef(condition, context);
  return 'is' in condition ? matches(value, condition.is) : !matches(value, condition.is_not);
});
const offeredAt = (place: string, context: Context) => shows(place).filter(action => offered(action, context));
// The rows of the space settings list an action chooses among, at its `choices.from` path (space-settings.json).
function choicesOf(choices: Choices): Choice[] {
  let value: unknown = spaceSettings;
  for (const key of choices.from) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  return Array.isArray(value) ? value as Choice[] : [];
}
/** A menu's rows for `list`: an action with `choices` opens them as its own rows (a swatch each when `swatches`, the
 *  current one checked and named at the row's end); `runs` says what each row id runs, so no id is ever parsed. */
function menuRows(list: SpaceAction[], context: Context) {
  const runs = new Map<string, { action: SpaceAction; chosen?: Choice }>();
  const rows = list.map((action): ActionMenuItem => {
    runs.set(action.id, { action });
    const row = { id: action.id, label: action.label, icon: action.icon, ...(action.tone ? { tone: action.tone } : {}), ...(action.confirm ? { confirm: words(action.confirm, context) } : {}) };
    if (!action.choices) return row;
    const { choices } = action;
    const current = choices.current ? readRef(choices.current, context) : undefined;
    const items = choicesOf(choices).map((chosen): ActionMenuItem => {
      const id = `${action.id}:${chosen.id}`;
      runs.set(id, { action, chosen });
      return { id, label: chosen.label, icon: choices.swatches ? { glyph: <ColorDot tone={chosen.id} size="md" /> } : action.icon, checked: chosen.id === current };
    });
    const named = items.find(item => item.checked)?.label;
    return { ...row, items, ...(named ? { hint: named } : {}) };
  });
  return { rows, runs };
}

// ---------------------------------------------------------------------------------------------------------------
// How one thing in a space reads: its title, the rest of its words, and who put it there.

function itemWords(item: Item): { title: string; detail: string; text: string } {
  const body = item.body;
  const parts = typeof body === 'string' ? [{ label: null as string | null, text: body }]
    : body && typeof body === 'object' ? Object.entries(body as Record<string, unknown>)
      .filter(([key, value]) => typeof value === 'string' && value.trim() && BODY_WORDS[key] !== null)
      .map(([key, value]) => ({ label: BODY_WORDS[key] ?? null, text: String(value) }))
      : [];
  const named = typeof (body as { name?: unknown } | null)?.name === 'string' ? String((body as { name: string }).name) : null;
  const text = parts.map(part => (part.label ? `${part.label}: ${part.text}` : part.text)).join('\n');
  const title = item.title ?? (named ? named.slice(named.lastIndexOf('/') + 1) : null) ?? parts[0]?.text ?? kindOf(item.kind).label;
  return { title, detail: parts.filter(part => part.text !== title).map(part => (part.label ? `${part.label}: ${part.text}` : part.text)).join(' · '), text };
}
const byWords = (item: Item) => (item.provenance.by_you ? 'you' : item.provenance.by);

// A file's family, picture and type from its stored type or name (file-previews.json), the same as the Files screen.
function fileLook(item: Item) {
  const name = String((item.body as { name?: string } | null)?.name ?? item.title ?? '');
  const stored = (item.body as { media_type?: string | null } | null)?.media_type;
  const row = previewFor(familyOf(name, stored));
  return { icon: row.icon, typeLabel: row.type_label, renderer: row.renderer, contentType: contentTypeOf(name, stored) || 'application/octet-stream' };
}

// What a thing shows as its picture, by its kind's `preview` (space-kinds.json). `bytes` is where the space serves the
// thing's own bytes (the address its board's picture cards use), so a file whose family draws as an image
// (file-previews.json `renderer`) shows itself.
const PREVIEWS: Record<string, (item: Item, bytes: string) => MediaPreviewProps> = {
  file: (item, bytes) => {
    const look = fileLook(item);
    return look.renderer === 'image'
      ? { renderer: 'image', source: bytes, title: itemWords(item).title, icon: look.icon, typeLabel: look.typeLabel }
      : { renderer: 'type-icon', title: itemWords(item).title, icon: look.icon, typeLabel: look.typeLabel };
  },
  text: item => ({ renderer: 'text-snippet', title: itemWords(item).title, text: itemWords(item).detail || itemWords(item).text, icon: kindOf(item.kind).icon, typeLabel: kindOf(item.kind).label }),
  // The picture a thing's body names (a shared link's own card fills it in), else the start of its words.
  picture: item => {
    const picture = (item.body as { picture?: unknown } | null)?.picture;
    return typeof picture === 'string' && picture ? { renderer: 'image', source: picture, title: itemWords(item).title } : PREVIEWS.text(item, '');
  },
};
const previewOf = (item: Item, bytes: string): MediaPreviewProps => (PREVIEWS[kindOf(item.kind).preview] ?? (() => ({ renderer: 'type-icon', title: itemWords(item).title, icon: kindOf(item.kind).icon, typeLabel: kindOf(item.kind).label })))(item, bytes);
/** Where a space serves one thing's own bytes (the address its board's picture cards use). */
const itemBytes = (spaceId: string, item: Item) => `${at(spaceId)}/items/${encodeURIComponent(item.item_id)}/bytes`;
/** A thing as its picture in a list: a file the way the Files screen shows it (file-previews.json, made previews for
 *  video, sound and pages), anything else by its kind's `preview`. */
const thingPicture = (row: { item: Item; bytes: string }) => {
  const reference = row.item.withdrawn ? null : sharedRecordReferencePage(row.item.body, { limit: 1 }).references[0];
  const split = row.bytes.indexOf('/items/');
  if (!row.item.withdrawn && (row.item.kind === 'file' || reference?.source === 'file') && split > 0) return <SharedRecordPreview spacePath={row.bytes.slice(0, split)} itemId={row.item.item_id}
    scopeKey={JSON.stringify([row.item.title, row.item.body, reference])} fallback={{ ...previewOf(row.item, ''), renderer: 'type-icon', source: undefined }} />;
  if (kindOf(row.item.kind).preview !== 'file') return mediaPreviewContent(previewOf(row.item, row.bytes));
  const body = (row.item.body ?? {}) as { name?: string; media_type?: string | null; identity?: string };
  return filePicture({ name: String(body.name ?? row.item.title ?? ''), mediaType: body.media_type, identity: body.identity, bytes: row.item.withdrawn ? null : row.bytes, title: itemWords(row.item).title });
};

// ---------------------------------------------------------------------------------------------------------------
// Contexts: what an action reads, for a space, one thing in it, one person, one agent.

const spaceContext = (space: { space_id: string; label?: string; title: string; description?: string | null; picture?: Picture | null; colour?: string | null; may?: Record<string, boolean>; member_types?: MemberType[]; joins_as?: string | null; members?: { name: string; you?: boolean }[] }): Context => ({
  you: { name: space.members?.find(member => member.you)?.name ?? null },
  space: {
    space_id: space.space_id, label: space.label ?? null, title: space.title, description: space.description ?? null, picture: space.picture ?? null, colour: space.colour ?? null, may: space.may ?? {},
    link: `${location.origin}${itemAddressOf(surfaces, 'trillion.space', space.space_id)}`, member_types: space.member_types ?? [], joins_as: space.joins_as ?? null,
  },
});
// What the rule builder offers, read from the rules the store answered: kinds of who (a kind that needs a value picks
// it from its fact's values), actions, and facts with the values each is compared with (listed, or read from the
// space's actions, member types or members). A space's own member type is named in the who menu when allowed.
function ruleBuilderData(rules: Rules, addType: ((name: string) => Promise<void>) | null) {
  const lists: Record<string, RuleBuilderOption[]> = {
    actions: rules.actions.map(action => ({ value: action.id, label: action.label })),
    member_types: rules.member_types.map(type => ({ value: type.id, label: type.label, ...(type.about ? { about: type.about } : {}) })),
    members: rules.members.map(member => ({ value: member.member_id, label: member.name })),
  };
  const facts = new Map(rules.facts.map(fact => [fact.id, fact]));
  const optionsOf = (fact: Fact | undefined) => fact?.values ?? lists[fact?.values_from ?? ''] ?? [];
  const whoKinds: RuleBuilderWhoKind[] = rules.who_kinds.map(kind => ({
    kind: kind.kind, label: kind.label, icon: kind.needs ? 'UsersRound' : 'Users', field: kind.needs,
    ...(kind.needs ? { options: optionsOf(facts.get(kind.needs)) } : {}),
    ...(kind.needs && addType && facts.get(kind.needs)?.values_from === 'member_types' ? { add: { label: 'New type…', placeholder: 'Name the type, like Editor', onAdd: addType } } : {}),
  }));
  const ruleFacts: RuleBuilderFact[] = rules.facts.map(fact => ({ id: fact.id, label: fact.label, kind: fact.kind, options: optionsOf(fact) }));
  const effects = Object.entries(RULE_EFFECTS).map(([effect, look]) => ({ id: effect, label: look.label, icon: look.icon }));
  return { effects, whoKinds, actions: lists.actions, facts: ruleFacts };
}
const itemContext = (base: Context, item: Item): Context => ({ ...base, item, thing: { title: itemWords(item).title, by: byWords(item) } });

function openSpace(space: { space_id: string; title: string }) {
  window.dispatchEvent(new CustomEvent(PLACEABLE_SURFACE_MIME, { cancelable: true, detail: { id: 'trillion.space', title: space.title, surfaceInput: { id: space.space_id } } }));
}
const openSpacesList = () => window.dispatchEvent(new CustomEvent(PLACEABLE_SURFACE_MIME, { cancelable: true, detail: { id: 'trillion.pursuits' } }));

// ---------------------------------------------------------------------------------------------------------------
// The one way any action runs: ask what its box asks for, confirm once, take its road, say what happened.

/** What a screen does for a `screen` road or an `after` (space-actions.json), by verb. */
type Verbs = Record<string, (context: Context) => void | Promise<void>>;
type Pending = { action: SpaceAction; context: Context };
type Picking = Pending & { folder: string };

// Each road kind: `post` to /work/api/spaces, `copy` to the clipboard, `screen` to the screen's own verb, `sharing`
// the one sharing sheet (sharing-sheet.tsx): for what its `words` name (the space itself), else for the picked thing,
// starting with this space switched on.
const ROADS: Record<string, (road: Road, context: Context, verbs: Verbs) => Promise<unknown>> = {
  post: async (road, context) => {
    const path = (road.path ?? []).map(part => encodeURIComponent(String(fill(part, context) ?? ''))).join('/');
    let body = (fill(road.body ?? {}, context) ?? {}) as Record<string, unknown>;
    if (road.community_role) {
      const space = context.space as { space_id?: string; member_types?: MemberType[] } | undefined;
      const community = context.community as CommunityView | undefined;
      if (!space?.space_id || !community?.config || !community.updated_at) throw new Error('Community role settings are available to members allowed to change community settings.');
      const current = await readJson<CommunityView>(`${OPEN_TO_YOU}/${encodeURIComponent(space.space_id)}`);
      if (current.updated_at !== community.updated_at || !current.config) throw new Error('This community changed. Reopen its rules and try again.');
      const roles = { ...(current.config.roles ?? {}) };
      const memberTypes = current.member_types ?? space.member_types ?? [];
      const asked = (context.asked ?? {}) as { label?: unknown; inherits?: unknown; may?: unknown };
      const memberType = context.member_type as MemberType | undefined;
      let roleId = memberType?.id;
      if (road.community_role === 'remove') {
        if (!roleId || !Object.hasOwn(roles, roleId)) throw new Error('That community role changed. Reopen its settings and try again.');
        delete roles[roleId];
        return readJson<Record<string, unknown>>(`/community/${encodeURIComponent(space.space_id)}`, {
          method: 'PUT', body: JSON.stringify({ config: { ...current.config, roles }, expected_updated_at: current.updated_at }),
        });
      }
      const label = typeof asked.label === 'string' ? asked.label.trim() : '';
      if (!label || label.length > 80) throw new Error('A role needs a name of up to 80 characters.');
      const inherits = Array.isArray(asked.inherits) ? asked.inherits.filter((id): id is string => typeof id === 'string') : [];
      const may = Array.isArray(asked.may) ? asked.may.filter((id): id is string => typeof id === 'string') : [];
      if (road.community_role === 'add') {
        const stem = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'role';
        const usedIds = new Set([...Object.keys(roles), ...memberTypes.map(type => type.id)]);
        roleId = stem;
        for (let suffix = 2; usedIds.has(roleId); suffix += 1) roleId = `${stem}-${suffix}`;
      }
      if (!roleId || (road.community_role === 'update' && !Object.hasOwn(roles, roleId))) throw new Error('That community role changed. Reopen its settings and try again.');
      if (inherits.some(id => !memberTypes.some(type => type.id === id))) throw new Error('Choose existing community roles to inherit.');
      if (may.some(id => !['put_on_events', 'remove_posts', 'set_roles', 'send_digests'].includes(id))) throw new Error('Choose a listed community permission.');
      const previous = roles[roleId] ?? {};
      roles[roleId] = { ...previous, label, inherits: [...new Set(inherits)], may: [...new Set(may)] };
      const config = { ...current.config, roles };
      return readJson<Record<string, unknown>>(`/community/${encodeURIComponent(space.space_id)}`, {
        method: 'PUT', body: JSON.stringify({ config, expected_updated_at: current.updated_at }),
      });
    }
    if (road.members_from) {
      const members = parseSpaceInviteEmails(String(readRef(road.members_from, context) ?? ''));
      if (members.length) body.members = members.map(email => ({ email }));
    }
    const to = `${road.at ?? API}/${path}`;
    const send = (value: Record<string, unknown>) => road.method === 'PUT'
      ? putJson<Record<string, unknown>>(to, value)
      : postJson<Record<string, unknown>>(to, value);
    let answer = await send(body);
    // A road read in pages goes on while the answer names where the next page starts.
    for (let cursor = road.pages ? readRef({ read: { from: 'answer', key: road.pages.cursor } }, { answer }) : null; road.pages && cursor !== null && cursor !== undefined;) {
      answer = await send({ ...body, [road.pages.field]: cursor });
      cursor = readRef({ read: { from: 'answer', key: road.pages.cursor } }, { answer });
    }
    return answer;
  },
  // `queue` asks the person's own AIs for the job row `job` names (src/workspace/queue-job.ts), with `context` read in.
  queue: async (road, context) => sendQueuedJob({ job_id: road.job ?? '', context: (fill(road.context ?? {}, context) ?? {}) as Record<string, string>, press_key: String((context.fresh as { key: string }).key) }),
  copy: async (road, context) => {
    if (!(await copyTextToClipboard(words(road.words, context)))) throw new Error('Copying did not work in this browser. Try again.');
    return null;
  },
  sharing: async (road, context) => {
    // A road naming its own `words` shares that (the space itself, `space:<id>`); else the thing just picked.
    const named = road.words ? words(road.words, context) : null;
    if (named) {
      const anchor = document.activeElement;
      (await import('./sharing-sheet')).openSharing(named, { title: (context.space as { title?: string } | undefined)?.title, anchor });
      return null;
    }
    const picked = context.picked as { record_id?: string; file?: string; title?: string } | undefined;
    const record = picked?.record_id ?? (picked?.file ? `file:${picked.file}` : null);
    if (!record) throw new Error('Pick one thing to share.');
    const anchor = document.activeElement;
    (await import('./sharing-sheet')).openSharing(record, { title: picked?.title, anchor });
    return null;
  },
  screen: async (road, context, verbs) => {
    const verb = verbs[road.verb ?? ''];
    if (!verb) throw new Error('This cannot be done here.');
    await verb(context);
    return null;
  },
};

function useActions(verbs: Verbs, reload: () => Promise<void>, onPlanNeeded: (error: PlanNeeded) => void) {
  const [asking, setAsking] = React.useState<Pending | null>(null);
  const [picking, setPicking] = React.useState<Picking | null>(null);
  const [composing, setComposing] = React.useState<Pending | null>(null);

  const perform = React.useCallback(async (action: SpaceAction, context: Context): Promise<GuideReveal | void> => {
    const run = ROADS[action.road.kind];
    if (!run) throw new Error('This cannot be done here.');
    const full: Context = { ...context, fresh: { key: crypto.randomUUID() } };
    try {
      full.answer = await run(action.road, full, verbs);
    } catch (error) {
      if (error instanceof PlanNeeded) { onPlanNeeded(error); return; }
      throw error;
    }
    if (action.copy && !(await copyTextToClipboard(words(action.copy, full)))) throw new Error('Copying did not work in this browser. Try again.');
    if (action.done) notify(words(action.done, full), { kind: 'done' });
    if (action.after) await verbs[action.after]?.(full);
    await reload();
    if (action.reveal) return { label: words(action.reveal.label, full), text: String(readRef(action.reveal.value, full) ?? '') };
  }, [verbs, reload, onPlanNeeded]);

  // Past the box: confirm once in the panel, or run.
  const proceed = React.useCallback((action: SpaceAction, context: Context, confirmed: boolean) => {
    if (action.confirm && !confirmed) { setAsking({ action, context }); return; }
    perform(action, context).catch(error => notify(errorWords(error), { kind: 'error' }));
  }, [perform]);

  // Starting an action: its box first. `confirmed` is true when the control it came from already asked (a menu's
  // two-step confirm, the guide's confirm in place).
  const begin = React.useCallback((action: SpaceAction, context: Context, confirmed = false) => {
    const box = action.box?.kind;
    if (box === 'composer') { setComposing({ action, context }); return; }
    if (box === 'pick') { setPicking({ action, context, folder: '/' }); return; }
    if (box === 'panel') { setAsking({ action, context }); return; }
    proceed(action, context, confirmed);
  }, [proceed]);

  const picked = React.useCallback((pending: Pending, thing: Context['picked']) => {
    setPicking(null);
    proceed(pending.action, { ...pending.context, picked: thing }, false);
  }, [proceed]);

  // `about` is the space items the message is about (the files sent with it); `mentions` what it `@`-mentions.
  // `parent` is the thing a reply answers, so an action can carry what that thing asks its replies to carry.
  const composed = React.useCallback(async (pending: Pending, text: string, about: string[] = [], mentions: Mention[] = [], replyTo?: string, parent?: Item) => {
    const context = { ...pending.context, asked: { text, ...(about.length ? { about } : {}), ...(mentions.length ? { mentions } : {}), ...(replyTo ? { reply_to: replyTo } : {}), ...(parent ? { parent } : {}) } };
    if (pending.action.confirm) { setAsking({ action: pending.action, context }); return; }
    await perform(pending.action, context);
  }, [perform]);

  return { begin, perform, picked, composed, asking, setAsking, picking, setPicking, composing, setComposing };
}

type Actions = ReturnType<typeof useActions>;

/** The panel an action asks in: its words, its fields, and one button; a revealed value shows once in it. */
function AskPanel({ actions }: { actions: Actions }) {
  const pending = actions.asking;
  const button = React.useMemo<GuideAction | null>(() => (pending ? {
    label: pending.action.label,
    tone: pending.action.tone === 'destructive' ? 'danger' : 'primary',
    ...(pending.action.box?.fields?.length ? { send: { path: '', with_fields: true } } : {}),
  } : null), [pending]);
  if (!pending || !button) return null;
  const { action, context } = pending;
  const body = words(action.box?.body ?? action.confirm, context);
  const fields = action.box?.fields ?? [];
  const description: GuideDescription = {
    title: action.label, hide_header: true,
    sections: fields.length
      ? [{ body, rows: [{ id: action.id, title: action.label, starts_open: true, fields: fields.map(field => {
        const listed = field.options_from ? readRef(field.options_from, context) : undefined;
        const excluded = field.exclude_value_from ? readRef(field.exclude_value_from, context) : undefined;
        const options = field.options ?? (Array.isArray(listed) ? listed.filter((item): item is MemberType => Boolean(item && typeof item === 'object' && 'id' in item && item.id !== excluded)).map(type => ({ value: type.id, label: type.label })) : undefined);
        const value = field.value_from ? readRef(field.value_from, context) : field.value;
        const values = field.values_from ? readRef(field.values_from, context) : field.values;
        return { name: field.name, label: field.label, kind: field.kind, secret: false, placeholder: field.placeholder, value: typeof value === 'string' ? value : undefined, values: Array.isArray(values) ? values.filter((one): one is string => typeof one === 'string') : undefined, options, add_label: field.add_label };
      }), actions: [button] } as GuideRow] }]
      : [{ body, actions: [button] }],
  };
  return (
    <FloatingPanel open onClose={() => actions.setAsking(null)} title={action.label} kind="space-action" width={440}>
      <React.Suspense fallback={null}>
        <Guide description={description} onAction={async (_pressed, values) => {
          for (const field of fields) if (!field.optional) {
            const value = values[field.name];
            if (Array.isArray(value) ? !value.length : typeof value !== 'string' || !value.trim()) { notify(`Fill in “${field.label}” first.`, { kind: 'error' }); return; }
          }
          const asked = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, Array.isArray(value) ? value : value.trim()]));
          try {
            const reveal = await actions.perform(action, { ...context, asked });
            if (reveal) return reveal;
            actions.setAsking(null);
          } catch (error) {
            notify(errorWords(error), { kind: 'error' });
          }
        }} />
      </React.Suspense>
    </FloatingPanel>
  );
}

// The things a picker offers, by the box's `source` (space-actions.json): the person's shareable records one page at
// a time, and their files one folder at a time.
type PickSource = (state: { folder: string; after: string | null }) => Promise<{ items: (Omit<CommandPaletteItem, 'run'> & { picked?: Context['picked']; folder?: string })[]; next: string | null }>;
async function filesIn(folder: string, after: string | null) {
  const listing = await readListing<FolderPage>(folder, { limit: 200, after });
  const up = folder === '/' ? [] : [{ id: `up:${folder}`, label: 'Back to the folder above', icon: 'CornerLeftUp', section: 'Files', folder: folder.slice(0, folder.lastIndexOf('/')) || '/' }];
  const folders = after ? [] : listing.folders.map(path => ({ id: `folder:${path}`, label: path.slice(path.lastIndexOf('/') + 1), icon: 'Folder', section: 'Files', folder: path }));
  const files = listing.names.map(file => {
    const name = file.name.slice(file.name.lastIndexOf('/') + 1);
    return { id: `file:${file.name}`, label: name, icon: fileLook({ item_id: '', kind: 'file', title: name, body: null, provenance: { origin: '', by: '', by_you: true, added_at: '' } }).icon, section: 'Files', hint: file.modified_at_ms ? relativeWhen(file.modified_at_ms) : undefined, picked: { file: file.name, title: name } };
  });
  return { items: [...up, ...folders, ...files], next: listing.next_after };
}
const PICK_SOURCES: Record<string, PickSource> = {
  files: ({ folder, after }) => filesIn(folder, after),
  shareable: async ({ folder, after }) => {
    const [records, files] = await Promise.all([
      after?.startsWith('files:') ? Promise.resolve({ items: [] as Shareable[], next_after: null }) : readJson<{ items: Shareable[]; next_after: string | null }>(`${API}/shareable${after ? `?after=${encodeURIComponent(after)}` : ''}`),
      after && !after.startsWith('files:') ? Promise.resolve({ items: [], next: null }) : filesIn(folder, after ? after.slice('files:'.length) : null),
    ]);
    const items = records.items.map(row => ({
      id: `${row.kind}:${row.record_id}`, label: row.title ?? kindOf(row.kind).label, icon: kindOf(row.kind).icon, section: `${kindOf(row.kind).label}s`,
      detail: row.detail ?? undefined, hint: row.at ? relativeWhen(row.at) : undefined, picked: { record_id: row.record_id, title: row.title ?? kindOf(row.kind).label },
    }));
    return { items: [...items, ...files.items], next: records.next_after ?? (files.next ? `files:${files.next}` : null) };
  },
};

/** The picker for an action whose box picks one thing; the other actions offered beside it are its last rows. */
function Picker({ actions, beside }: { actions: Actions; beside: SpaceAction[] }) {
  const picking = actions.picking;
  const [rows, setRows] = React.useState<CommandPaletteItem[]>([]);
  const [next, setNext] = React.useState<string | null>(null);
  const source = picking ? PICK_SOURCES[picking.action.box?.source ?? ''] : undefined;
  const load = React.useCallback(async (after: string | null) => {
    if (!picking || !source) return;
    try {
      const page = await source({ folder: picking.folder, after });
      const built = page.items.map(({ picked, folder, ...row }) => ({
        ...row,
        run: () => {
          if (folder !== undefined) { actions.setPicking({ ...picking, folder }); return; }
          actions.picked(picking, picked);
        },
      }));
      const others = after ? [] : beside.filter(action => action.id !== picking.action.id && offered(action, picking.context)).map(action => ({
        id: `action:${action.id}`, label: action.label, icon: action.icon, section: 'More',
        run: () => { actions.setPicking(null); actions.begin(action, picking.context); },
      }));
      setRows(current => (after ? [...current.filter(row => !row.id.startsWith('action:')), ...built, ...current.filter(row => row.id.startsWith('action:'))] : [...built, ...others]));
      setNext(page.next);
    } catch (error) {
      notify(errorWords(error), { kind: 'error' });
    }
  }, [picking, source, beside, actions]);
  React.useEffect(() => { setRows([]); setNext(null); void load(null); }, [load]);
  if (!picking) return null;
  return (
    <CommandPalette
      open
      onClose={() => actions.setPicking(null)}
      items={rows}
      placeholder={`${picking.action.label}: find what to pick`}
      emptyLabel="Nothing here to pick yet."
      {...(next ? { more: { label: 'Show more', run: () => void load(next) } } : {})}
    />
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Shared record views held in a React tree: mounted once, given new options on every draw.

function Records(options: RecordViewsOptions) {
  const host = React.useRef<HTMLDivElement>(null);
  const views = React.useRef<ReturnType<typeof mountRecordViews> | null>(null);
  React.useEffect(() => {
    if (!host.current) return undefined;
    views.current = mountRecordViews(host.current, options);
    return () => { views.current?.destroy(); views.current = null; };
    // Mounted once; every later draw goes through `update` below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  React.useEffect(() => { views.current?.update(options); });
  return <Container ref={host} layout="vertical" flex="1" minHeight="0" />;
}

/** Row actions for a record views list: the actions offered at `place`, each run for every chosen record. */
function rowActions<T>(place: string, contextOf: (row: T) => Context, actions: Actions, rowOf: (id: string) => T | undefined): BulkAction[] {
  return shows(place).map(action => ({
    id: action.id, label: action.label, icon: action.icon, ...(action.tone ? { tone: action.tone } : {}), lead: Boolean(action.primary),
    appliesTo: (row: T) => offered(action, contextOf(row)),
    run: (ids: string[]) => ids.forEach(id => { const row = rowOf(id); if (row) actions.begin(action, contextOf(row)); }),
  }));
}

// ---------------------------------------------------------------------------------------------------------------
// Spaces: the heading (its explanation behind the info icon), invitations, every space as a card, and what
// other people do with spaces.

/** A space the person is not in yet that anyone may join (src/community.mjs `communities`). */
type OpenToYou = { community_id: string; title: string; about: string | null; members: number; member: boolean; may_join: boolean };
type ListRead = { spaces: SpaceSummary[]; invitations: Invitation[]; open: OpenToYou[] };

const LIST_INFO = 'Everything you are working toward. Share one with people and their AIs and it holds what each of you puts there; nothing else in your Trillion is shown to them.';

// Names read as a phrase: "Ana", "Ana and Ben", "Ana, Ben and Cai", "Ana, Ben and 4 more".
function namesPhrase(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}
// What a space holds, in words: "2 messages · 1 pursuit".
const holds = (byKind: Record<string, number>) => Object.entries(byKind).filter(([, count]) => count > 0)
  .map(([kind, count]) => plural(count, kindOf(kind).label.toLowerCase(), kindOf(kind).plural ?? `${kindOf(kind).label.toLowerCase()}s`)).join(' · ');
// The letters that stand for a space while it has no picture.
const lettersOf = (title: string) => title.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]?.toUpperCase() ?? '').join('') || '?';
const activeWords = (iso: string | null) => (iso ? `Active ${relativeWhen(iso, undefined, { inSentence: true })}` : '');

/** Where each listed space's picture is read, once per picture; a picture that cannot be read shows its letters. */
function usePictureUrls(spaces: { space_id: string; picture: Picture | null }[]) {
  const [urls, setUrls] = React.useState<Record<string, string>>({});
  const keyOf = (space: { space_id: string; picture: Picture | null }) => (space.picture ? `${space.space_id}:${space.picture.item_id}` : '');
  const wanted = spaces.map(keyOf).filter(Boolean).join('|');
  React.useEffect(() => {
    let live = true;
    const pictured = spaces.filter(space => space.picture);
    void Promise.all(pictured.map(space => readJson<{ url: string }>(`${at(space.space_id)}/picture`).then(answer => [keyOf(space), answer.url] as const, () => null)))
      .then(rows => { if (live) setUrls(Object.fromEntries(rows.filter((row): row is readonly [string, string] => row !== null))); });
    return () => { live = false; };
    // Read again only when which pictures are listed changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);
  return (space: { space_id: string; picture: Picture | null }) => urls[keyOf(space)] ?? null;
}

// A space as a card in the glance shape: its picture (or its letters), its name with when it was last active muted
// under it, how much is new since the person last looked alone on the right, its words, what it holds and who is in it
// by their faces.
function spaceListing(space: SpaceSummary, picture: string | null): Listing {
  const look = spaceLook(space.label);
  const inIt = holds(space.items_by_kind ?? {});
  const names = space.member_names ?? [];
  return {
    id: space.space_id,
    title: space.title,
    ...(space.last_activity_at ? { when: activeWords(space.last_activity_at) } : {}),
    ...(space.description ? { text: space.description } : {}),
    icon: look.icon ?? 'UsersRound',
    cover: { picture, letters: lettersOf(space.title), colour: space.colour },
    ...(space.unread ? { value: String(space.unread), unit: 'new', valueLabel: `${space.unread} new`, mark: { label: `${space.unread} new`, tone: 'info' } } : {}),
    facts: inIt ? [{ label: 'In it', value: inIt, icon: 'Layers' }] : [],
    ...(names.length ? { people: names.map((name, index) => ({ key: `${index}:${name}`, node: <PersonTag name={name} size="sm" /> })), peopleLabel: namesPhrase(names) } : {}),
  };
}

const listingActions = (place: string, context: Context) => offeredAt(place, context).map(action => ({ id: action.id, label: action.label, ...(action.icon ? { icon: action.icon } : {}), ...(action.primary ? { primary: true } : {}) }));

// An invite link arrives as the list's address with its code (src/space-settings.json invites.join_address).
const JOIN_PARAMETER = spaceSettings.invites.join_address.code_parameter;
function useJoinOffer() {
  const [code] = React.useState(() => new URLSearchParams(location.search).get(JOIN_PARAMETER));
  const [offer, setOffer] = React.useState<{ code: string; offer: JoinOffer } | { code: string; error: string } | null>(null);
  React.useEffect(() => {
    if (!code) return;
    readJson<JoinOffer>(`${API}/join/${encodeURIComponent(code)}`)
      .then(answer => setOffer({ code, offer: answer }), error => setOffer({ code, error: errorWords(error) }));
  }, [code]);
  return offer;
}

// The spaces the person archived from their own list (src/person-spaces.mjs), read only while the list shows them.
const readArchived = async () => (await readJson<{ spaces: SpaceSummary[] }>(`${API}?archived=true`)).spaces;
// A space as its card's menu reads it: the space, with the address that opens it.
const cardContext = (space: SpaceSummary): Context => ({ space: { ...space, link: new URL(itemAddressOf(surfaces, 'trillion.space', space.space_id), location.origin).toString() } });

/** The read the spaces list is drawn from, the kind of its dirty notices (src/spaces.mjs SPACES_READ). */
const SPACES_READ = '/work/api/spaces';
function SpacesList({ first, read }: { first: ListRead; read: () => Promise<ListRead> }) {
  const [list, setList] = React.useState(first);
  // The archived spaces while the list shows them; null while it shows the person's spaces.
  const [archived, setArchived] = React.useState<SpaceSummary[] | null>(null);
  const showingArchived = React.useRef(false);
  const [planNeeded, setPlanNeeded] = React.useState<PlanNeeded | null>(null);
  React.useEffect(() => (planNeeded ? mountSpacesPlanGate(planNeeded, () => setPlanNeeded(null)) : undefined), [planNeeded]);
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const reload = React.useCallback(async () => {
    try {
      const [next, hidden] = await Promise.all([read(), showingArchived.current ? readArchived() : Promise.resolve(null)]);
      if (mounted.current) {
        setList(current => ({ ...current, spaces: next.spaces }));
        setArchived(showingArchived.current ? hidden : null);
      }
    } catch (error) { if (mounted.current) notify(errorWords(error), { kind: 'error' }); }
  }, [read]);
  const verbs = React.useMemo<Verbs>(() => ({
    'show-archived': () => { showingArchived.current = true; },
    'show-current': () => { showingArchived.current = false; },
    'open-space': context => {
      const answer = context.answer as { membership_id?: string; space_id?: string } | undefined;
      const space = context.space as { space_id: string; title: string } | undefined;
      const asked = context.asked as { title?: string } | undefined;
      const id = answer?.membership_id ?? answer?.space_id ?? space?.space_id;
      if (id) openSpace({ space_id: id, title: asked?.title ?? space?.title ?? '' });
      if (context.join) {
        const address = new URL(location.href);
        address.searchParams.delete(JOIN_PARAMETER);
        replaceWorkspaceAddress(history.state, address);
      }
    },
    left: () => undefined,
  }), []);
  const actions = useActions(verbs, reload, setPlanNeeded);
  // A dirty notice for the spaces list (its version moved) reads it again by itself; every other change still reaches it by the revision.
  React.useEffect(() => onStoreChange(reload, [SPACES_READ]), [reload]);
  const pictureOf = usePictureUrls(archived ? [...list.spaces, ...archived] : list.spaces);
  const joining = useJoinOffer();

  const listContext: Context = { list: archived ? { archived: true } : {} };
  const header = offeredAt('list-header', listContext);
  const start = header.find(action => action.primary);
  // Each space card's ⋯ menu: the actions offered on a card (space-actions.json `space-card`), its confirm asked in the menu.
  const cardMenu = (space: SpaceSummary | undefined) => {
    if (!space) return null;
    const context = cardContext(space);
    const menu = menuRows(offeredAt('space-card', context), context);
    if (!menu.rows.length) return null;
    return (
      <ActionMenu
        label={`More for ${space.title}`}
        items={menu.rows}
        onAction={(chosen: string) => { const row = menu.runs.get(chosen); if (row) actions.begin(row.action, context, Boolean(row.action.confirm)); }}
      />
    );
  };
  const cards = (spaces: SpaceSummary[], label: string) => (
    <ListingGrid
      label={label}
      listings={spaces.map(space => spaceListing(space, pictureOf(space)))}
      onOpen={id => { const space = spaces.find(row => row.space_id === id); if (space) openSpace(space); }}
      controls={listing => cardMenu(spaces.find(space => space.space_id === listing.id))}
    />
  );
  const invitationContext = (invitation: Invitation): Context => ({ invitation });
  const invitations: Listing[] = list.invitations.map(invitation => ({
    id: invitation.request_id,
    title: invitation.space.title ?? 'A pursuit',
    byline: `Invited ${relativeWhen(invitation.asked_at, undefined, { inSentence: true })}`,
    ...(invitation.why ? { text: `“${invitation.why}”` } : {}),
    icon: invitation.space.label ? spaceLook(invitation.space.label).icon ?? 'UsersRound' : 'UsersRound',
    actions: listingActions('invitation', invitationContext(invitation)),
  }));
  // An invite link's space, with Join; a link that does not work says why in the store's own words.
  const joinContext = (code: string, title: string): Context => ({ join: { code }, space: { title } });
  const joinCard: Listing | null = !joining ? null : 'error' in joining
    ? { id: joining.code, title: 'This invite link does not work', text: joining.error, icon: 'Link2Off', actions: [] }
    : {
      id: joining.code, title: joining.offer.space.title,
      byline: [spaceLook(joining.offer.space.label).label, plural(joining.offer.space.members, 'person', 'people')].join(' · '),
      ...(joining.offer.space.description ? { text: joining.offer.space.description } : {}),
      icon: spaceLook(joining.offer.space.label).icon ?? 'UsersRound',
      cover: { picture: null, letters: lettersOf(joining.offer.space.title), colour: joining.offer.space.colour ?? null },
      actions: listingActions('join-link', joinContext(joining.code, joining.offer.space.title)),
    };
  const openContext = (row: OpenToYou): Context => ({ space: { space_id: row.community_id, title: row.title } });
  const openToYou: Listing[] = list.open.map(row => ({
    id: row.community_id,
    title: row.title,
    byline: plural(row.members, 'person', 'people'),
    ...(row.about ? { text: row.about } : {}),
    icon: 'UsersRound',
    cover: { picture: null, letters: lettersOf(row.title) },
    actions: listingActions('open-to-you', openContext(row)),
  }));
  const answerOpen = (spaceId: string, actionId: string) => {
    const row = list.open.find(one => one.community_id === spaceId);
    const action = ACTIONS.find(one => one.id === actionId);
    if (row && action) actions.begin(action, openContext(row));
  };
  const answerInvitation = (requestId: string, actionId: string) => {
    const invitation = list.invitations.find(one => one.request_id === requestId);
    const action = ACTIONS.find(one => one.id === actionId);
    if (invitation && action) actions.begin(action, invitationContext(invitation));
  };

  return (
    <Container layout="vertical" gap="xl" padding="lg" flex="1" minHeight="0" overflow="y-auto">
      <Container layout="vertical" gap="xl" width="full" maxWidth="6xl" marginX="auto">
        <CollectionHeader
          title={archived ? 'Archived pursuits' : 'Pursuits'}
          info={{ label: 'About pursuits', text: LIST_INFO }}
          actions={header.map(action => ({ id: action.id, label: action.label, icon: action.icon, ...(action.primary ? { primary: true } : {}) }))}
          onAction={id => { const action = header.find(one => one.id === id); if (action) actions.begin(action, listContext); }}
        />
        {archived ? (archived.length ? cards(archived, 'Archived pursuits') : (
          <ScreenState state={{
            status: 'empty', icon: 'Archive', title: 'Nothing archived',
            description: 'Archive a pursuit from its menu to take it out of your lists. Anyone you share it with keeps it, and Put back returns it.',
          }} />
        )) : null}
        {!archived && joinCard ? (
          <Container layout="vertical" gap="md">
            <Text variant="heading-xs">You were invited</Text>
            <ListingGrid label="You were invited" listings={[joinCard]} onAction={(code, actionId) => {
              const action = ACTIONS.find(one => one.id === actionId);
              if (action && joining && !('error' in joining)) actions.begin(action, joinContext(code, joining.offer.space.title));
            }} />
          </Container>
        ) : null}
        {!archived && invitations.length ? (
          <Container layout="vertical" gap="md">
            <Text variant="heading-xs">Waiting for your answer</Text>
            <ListingGrid label="Waiting for your answer" listings={invitations} onAction={answerInvitation} />
          </Container>
        ) : null}
        {archived ? null : list.spaces.length ? (
          <Container layout="vertical" gap="md">
            <Text variant="heading-xs">Your pursuits</Text>
            {cards(list.spaces, 'Your pursuits')}
          </Container>
        ) : (
          <ScreenState state={{
            status: 'empty', icon: 'UsersRound', title: 'You have no pursuits yet',
            description: 'Start one and invite people into it, or ask your AI. When someone invites you, the invitation shows here first.',
            ask: askFor('spaces'),
            ...(start ? { action: { label: start.label, run: () => actions.begin(start, {}) } } : {}),
          }} />
        )}
        {!archived && openToYou.length ? (
          <Container layout="vertical" gap="md">
            <Text variant="heading-xs">Open to you</Text>
            <ListingGrid label="Open to you" listings={openToYou} onAction={answerOpen} onOpen={spaceId => { const row = list.open.find(one => one.community_id === spaceId); if (row) openSpace({ space_id: row.community_id, title: row.title }); }} />
          </Container>
        ) : null}
      </Container>
      <AskPanel actions={actions} />
      <Picker actions={actions} beside={[]} />
    </Container>
  );
}

/** One pursuit record (home-records.json `pursuits.type`) as a card of the list: its own words, nothing invented. */
const pursuitCard = ({ id, value }: StoredRecord): SpaceSummary => {
  const words = (key: string) => (typeof value?.[key] === 'string' && (value[key] as string).trim() ? (value[key] as string).trim() : null);
  const title = words('title') ?? id;
  return { space_id: id, label: words('label') ?? title, title, description: words('description') ?? words('now'), picture: null,
    colour: words('colour'), member_names: [], items: 0, items_by_kind: {}, unread: Number(value?.unread) || 0, seen_at: null,
    last_activity_at: words('updated_at') ?? words('made_at'), members: 1 };
};

export function mountSpacesScreen(element: HTMLElement): () => void {
  let unmount: (() => void) | null = null;
  let unmountGate: (() => void) | null = null;
  // The person's pursuits are their pursuit records, read through the records door like the sidebar's pursuit rows.
  // Invitations and open communities have no owner in the engine (macos/release.json route_owner_gate.retired), so
  // the list asks for neither.
  const read = async (): Promise<ListRead> => ({ spaces: (await listRecords({ type: homeRecords.pursuits.type })).map(pursuitCard), invitations: [], open: [] });
  const screen = loadScreen(element, {
    loading: { label: 'Loading your pursuits', layout: 'gallery' },
    read,
    failed: (error, retry) => {
      if (error instanceof PlanNeeded) {
        unmountGate?.();
        unmountGate = mountSpacesPlanGate(error);
      }
      return failedState(error, retry, 'Your pursuits could not load');
    },
    clear: () => { unmount?.(); unmount = null; },
    // The list reads itself again from here on (SpacesList); this draws it once.
    draw: first => { unmountGate?.(); unmountGate = null; if (!unmount) unmount = mountReactSurface(element, <SpacesList first={first} read={read} />); },
  });
  return () => { screen.dispose(); unmountGate?.(); element.replaceChildren(); };
}

// ---------------------------------------------------------------------------------------------------------------
// One space.

// The AIs in the space (src/space-ais.mjs): each member's AIs that reach it, and on your own row the AIs you can add.
type SpaceAis = { members: { name: string; you: boolean; ais: { name: string }[]; can_add?: { ai_id: string; name: string }[] }[] };
type SpaceAi = { id: string; name: string; member: string };
/** `community` is what the space's turned-on parts show this person (null when none can be read). */
type Snapshot = { space: Space; page: Page; pageKey?: string; handoffs: Handoff[]; invites: Invite[]; rules: Rules; ais: SpaceAis; community: CommunityView | null };
type Opened = { item: Item };
type Thing = { id: string; item: Item; bytes: string; kind: string; title: string; words: string; by: string; author: string; sender: string; source_app: string; origin: string; when: number; replies_to: string; state: string; facts: Record<string, string | number | boolean> };

const THING_FIELDS: FieldDescriptor[] = [
  { id: 'picture', label: 'Picture', icon: 'Image', kind: 'thumbnail', width: 72, sortable: false, read: () => '', render: (row: Thing) => thingPicture(row) },
  { id: 'title', label: 'Title', icon: 'Text', ruleKind: 'text', filterable: true, sortable: true, width: 320, preview: 'heading', role: 'title' },
  { id: 'kind', label: 'Kind', icon: 'Shapes', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 130, values: Object.fromEntries(Object.keys(KINDS).map(kind => [kind, { label: kindOf(kind).label, icon: kindOf(kind).icon, tone: kindOf(kind).tone }])) },
  { id: 'by', label: 'Who put it here', icon: 'User', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 160 },
  { id: 'author', label: 'Written by', icon: 'User', ruleKind: 'text', width: 160, hiddenByDefault: true, role: 'author' },
  { id: 'sender', label: 'Original sender', icon: 'MessagesSquare', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 170 },
  { id: 'source_app', label: 'From', icon: 'Bot', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 150 },
  { id: 'origin', label: 'Where it came from', icon: 'Route', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 180 },
  { id: 'when', label: 'When', icon: 'CalendarClock', kind: 'date', ruleKind: 'date', filterable: true, groupable: true, sortable: true, width: 170, read: (row: Thing) => dateText(row.item.provenance.added_at), factValue: (row: Thing) => row.when, sortValue: (row: Thing) => row.when, role: 'when' },
  { id: 'words', label: 'Its words', icon: 'AlignLeft', kind: 'excerpt', ruleKind: 'text', filterable: true, width: 360, preview: true, role: 'body' },
  { id: 'replies_to', label: 'Replies to', icon: 'Reply', ruleKind: 'text', filterable: true, width: 220, hiddenByDefault: true },
  // What a reply answers, as the item ids its `about` names: the thread views nest replies under it, to any depth.
  { id: 'state', label: 'Taken back', icon: 'Undo2', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 130, hiddenByDefault: true },
  ...ITEM_FACTS.map((fact): FieldDescriptor => ({
    id: `fact:${fact.id}`, label: fact.label, icon: fact.icon, kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 150,
    read: (row: Thing) => row.facts[fact.id] ?? '', ...(fact.values ? { values: fact.values } : {}), ...(fact.role ? { role: fact.role } : {}),
  })),
];
// People: the type column is a menu for whoever the space's rules let give people their type, words for everyone else.
const typeLabel = (space: Space, id: string) => space.member_types.find(type => type.id === id)?.label ?? readable(id);
const inheritedTypeLabels = (space: Space, type: MemberType) => {
  const found = new Set<string>();
  const visit = (id: string) => {
    if (found.has(id)) return;
    found.add(id);
    for (const parent of space.member_types.find(candidate => candidate.id === id)?.inherits ?? []) visit(parent);
  };
  for (const parent of type.inherits ?? []) visit(parent);
  return [...found].map(id => typeLabel(space, id));
};
const memberFields = (space: Space, setType: (member: Member, type: string) => void): FieldDescriptor[] => [
  { id: 'name', label: 'Name', icon: 'User', ruleKind: 'text', filterable: true, sortable: true, width: 260, render: (row: Member) => <PersonTag name={row.name} showName size="sm" /> },
  {
    id: 'role', label: 'Type', icon: 'BadgeCheck', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 180,
    read: (row: Member) => typeLabel(space, row.role),
    ...(space.may?.set_member_type ? { render: (row: Member) => (
      <ActionMenu
        label={`Type for ${row.name}`}
        trigger={<Button variant="ghost" size="sm" />}
        triggerContent={<>{typeLabel(space, row.role)}<NamedIcon name="chevron-down" size="xs" aria-hidden /></>}
        items={space.member_types.map(type => ({ id: type.id, label: type.label, icon: 'BadgeCheck', checked: type.id === row.role }))}
        onAction={type => setType(row, type)}
      />
    ) } : {}),
  },
  { id: 'you', label: 'You', icon: 'Star', kind: 'tag', ruleKind: 'choice', filterable: true, width: 100, read: (row: Member) => (row.you ? 'You' : ''), values: { You: { tone: 'info' } } },
];
const memberTypeFields = (space: Space): FieldDescriptor[] => [
  { id: 'label', label: 'Type', icon: 'BadgeCheck', ruleKind: 'text', filterable: true, sortable: true, width: 220, read: (row: MemberType) => row.label },
  { id: 'inherits', label: 'Also has permissions of', icon: 'Layers', ruleKind: 'text', filterable: true, width: 320, read: (row: MemberType) => inheritedTypeLabels(space, row).join(', ') || 'No inherited permissions' },
  { id: 'source', label: 'Kind', icon: 'Shapes', kind: 'tag', ruleKind: 'choice', filterable: true, width: 170, read: (row: MemberType) => row.source === 'community' ? 'Community role' : row.own ? 'This pursuit' : 'Starting type', values: { 'Community role': { tone: 'quiet' }, 'This pursuit': { tone: 'info' }, 'Starting type': { tone: 'quiet' } } },
];
const INVITE_FIELDS: FieldDescriptor[] = [
  { id: 'made_at', label: 'Made', icon: 'CalendarPlus', kind: 'date', ruleKind: 'date', filterable: true, sortable: true, width: 190, read: (row: Invite) => dateText(row.made_at), factValue: (row: Invite) => Date.parse(row.made_at), sortValue: (row: Invite) => Date.parse(row.made_at) },
  { id: 'state', label: 'What became of it', icon: 'CircleDot', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 170, values: INVITE_STATES },
  { id: 'expires_at', label: 'Stops working', icon: 'CalendarClock', kind: 'date', ruleKind: 'date', filterable: true, sortable: true, width: 190, read: (row: Invite) => dateText(row.expires_at), factValue: (row: Invite) => Date.parse(row.expires_at), sortValue: (row: Invite) => Date.parse(row.expires_at) },
];
const AGENT_FIELDS: FieldDescriptor[] = [
  { id: 'name', label: 'Agent', icon: 'Bot', ruleKind: 'text', filterable: true, sortable: true, width: 220 },
  { id: 'description', label: 'What it does', icon: 'AlignLeft', ruleKind: 'text', filterable: true, width: 360, preview: true },
  { id: 'member', label: 'Whose it is', icon: 'User', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 160 },
  { id: 'takes_work', label: 'Takes work', icon: 'CircleDot', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 140, read: (row: Agent) => (row.takes_work ? 'Taking work' : 'Paused'), values: { 'Taking work': { tone: 'success' }, Paused: { tone: 'neutral' } } },
];
const AI_FIELDS: FieldDescriptor[] = [
  { id: 'name', label: 'AI', icon: 'Bot', ruleKind: 'text', filterable: true, sortable: true, width: 240 },
  { id: 'member', label: 'Whose it is', icon: 'User', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 180 },
];
const workFields = (agents: Agent[]): FieldDescriptor[] => [
  { id: 'job', label: 'Job', icon: 'ClipboardList', ruleKind: 'text', filterable: true, sortable: true, width: 340, preview: 'heading' },
  { id: 'to', label: 'Handed to', icon: 'Bot', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 180, read: (row: Handoff) => (row.to_agent ? agents.find(agent => agent.agent_id === row.to_agent)?.name ?? row.to_agent : 'Whoever takes it first') },
  { id: 'state', label: 'State', icon: 'CircleDot', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 150, values: WORK_STATES },
  { id: 'handed_at', label: 'Handed over', icon: 'CalendarClock', kind: 'date', ruleKind: 'date', filterable: true, sortable: true, width: 170, read: (row: Handoff) => dateText(row.handed_at), factValue: (row: Handoff) => Date.parse(row.handed_at), sortValue: (row: Handoff) => Date.parse(row.handed_at) },
  { id: 'finished_at', label: 'Done', icon: 'CalendarCheck', kind: 'date', ruleKind: 'date', filterable: true, sortable: true, width: 170, read: (row: Handoff) => dateText(row.finished_at), factValue: (row: Handoff) => (row.finished_at ? Date.parse(row.finished_at) : null), sortValue: (row: Handoff) => (row.finished_at ? Date.parse(row.finished_at) : 0) },
  { id: 'summary', label: 'What came of it', icon: 'AlignLeft', kind: 'excerpt', ruleKind: 'text', filterable: true, width: 340, read: (row: Handoff) => row.summary ?? '', preview: true },
];

/** What a space's turned-on parts show this person, or null when they cannot be read. */
const readTurnedOn = (id: string) => readAnswer<CommunityView>(turnedOnAt(id)).then(answer => (answer.ok ? answer.value : null), () => null);

async function readSpace(id: string, item?: string, kinds?: string[]): Promise<Snapshot> {
  const [space, page, work, made, rules, ais, community] = await Promise.all([
    readJson<Space>(at(id)),
    readSpaceTargetPage(at(id), item, readJson<Page>, { kinds }),
    postJson<{ handoffs: Handoff[] }>(`${at(id)}/handoffs/read`, {}),
    readJson<{ invites: Invite[] }>(`${at(id)}/invites`),
    readJson<Rules>(`${at(id)}/rules`),
    readJson<SpaceAis>(`${at(id)}/ais`),
    readTurnedOn(id),
  ]);
  return { space, page, pageKey: spacePageKey(kinds), handoffs: work.handoffs, invites: made.invites, rules, ais, community };
}


type LessonRoute = { course_id: string; lesson_id: string };

function SpaceView({ id, first, place, item, lesson }: { id: string; first: Snapshot; item?: string; place: string; lesson?: LessonRoute }) {
  const [snapshot, setSnapshot] = React.useState(first);
  // The place this tab is on (its row in the sidebar). Writing a message moves it to Messages in place, since what is
  // being written lives here; going anywhere else opens that place as its own screen (openPlace).
  const [current, setCurrent] = React.useState(place);
  React.useEffect(() => { setCurrent(place); }, [place]);
  const [olderPages, setOlderPages] = React.useState<{ before: string; page: Page }[]>([]);
  const [before, setBefore] = React.useState<string | null>(first.page.next_before);
  const [opened, setOpened] = React.useState<Opened | null>(null);
  const [left, setLeft] = React.useState(false);
  const [planNeeded, setPlanNeeded] = React.useState<PlanNeeded | null>(null);
  // The one message the address names (`/spaces/<space>/<item>`, a notice about it) is scrolled to and marked at once.
  const [reveal, setReveal] = React.useState<{ id: string; nonce: number } | undefined>(item ? { id: item, nonce: 1 } : undefined);
  // Why the last save of the rules was refused, each reason beside its rule (the store's words).
  const [ruleProblems, setRuleProblems] = React.useState<RuleBuilderProblem[]>([]);
  const { space, page, handoffs, invites, rules, ais } = snapshot;
  const isCurrentMember = space.space_id === id && space.members.some(member => member.you === true);
  const membershipLease = React.useRef<ReturnType<typeof registerShowSpaceMembership> | null>(null);
  React.useEffect(() => {
    const lease = registerShowSpaceMembership(space, !left && isCurrentMember);
    membershipLease.current = lease;
    return () => {
      lease.release();
      if (membershipLease.current === lease) membershipLease.current = null;
    };
  }, [id]);
  React.useEffect(() => { membershipLease.current?.update(space, !left && isCurrentMember); }, [space, isCurrentMember, left]);
  // Every member's AIs in this space, one row each, and your own AIs you can still add (src/space-ais.mjs).
  const aiRows: SpaceAi[] = ais.members.flatMap((member, index) => member.ais.map((ai, at) => ({ id: `ai:${index}:${at}`, name: ai.name, member: member.you ? 'You' : member.name })));
  const mine = ais.members.find(member => member.you);
  const addAi = async (aiId: string) => {
    try {
      const answer = await postJson<{ said: string }>(`${at(id)}/ais/add`, { ai: aiId });
      notify(answer.said, { kind: 'success' });
      await reload();
    } catch (error) { notify(errorWords(error), { kind: 'error' }); }
  };
  const base = React.useMemo(() => spaceContext(space), [space]);
  // What `@` offers here: the members, the AIs at work here, and the person's own things (src/workspace/mentions.ts).
  const { mentions, mentionKinds, onMentionQuery } = useMentions(id);
  const chips = useMentionChips(mentionKinds);
  const loadGeneration = React.useRef(0);
  const pageReadGeneration = React.useRef(0);
  const selectedKinds = React.useMemo(() => PLACES.find(row => row.id === current)?.kinds, [current]);
  const selectedPageKey = spacePageKey(selectedKinds);
  const pageReady = (snapshot.pageKey ?? spacePageKey()) === selectedPageKey;
  const [pageFailed, setPageFailed] = React.useState(false);

  const readSelectedPage = React.useCallback(async () => {
    const generation = ++loadGeneration.current;
    ++pageReadGeneration.current;
    setOlderPages([]);
    setBefore(null);
    setPageFailed(false);
    try {
      const next = await readSpaceTargetPage(at(id), item, readJson<Page>, { kinds: selectedKinds });
      if (generation !== loadGeneration.current) return;
      setSnapshot(current => ({ ...current, page: next, pageKey: selectedPageKey }));
      setBefore(next.next_before);
    } catch (error) {
      if (generation !== loadGeneration.current) return;
      if (error instanceof PlanNeeded) setPlanNeeded(error);
      else setPageFailed(true);
    }
  }, [id, item, selectedPageKey]);

  const reload = React.useCallback(async () => {
    const generation = ++loadGeneration.current;
    ++pageReadGeneration.current;
    try {
      const next = await readSpace(id, item, selectedKinds);
      if (generation !== loadGeneration.current) return;
      // A refresh must reconcile every page already shown, not just the newest page. This makes withdrawal and
      // other edits replace the old body, facts and design extras wherever that item was loaded.
      const refreshed: { before: string; page: Page }[] = [];
      let cursor = next.page.next_before;
      for (const prior of olderPages) {
        if (!cursor) break;
        const page = await readSpaceListPage(at(id), readJson<Page>, { kinds: selectedKinds, before: cursor });
        if (generation !== loadGeneration.current) return;
        refreshed.push({ before: cursor, page });
        cursor = page.next_before;
      }
      setSnapshot(next);
      setOlderPages(refreshed);
      setBefore(cursor);
      setPageFailed(false);
    } catch (error) {
      if (generation !== loadGeneration.current) return;
      const status = (error as { status?: number } | null)?.status;
      if (status === 401 || status === 403 || status === 404) membershipLease.current?.update(space, false);
      if (error instanceof PlanNeeded) setPlanNeeded(error);
      else notify(errorWords(error), { kind: 'error' });
    }
  }, [id, item, olderPages, selectedPageKey]);
  React.useEffect(() => {
    ++loadGeneration.current;
    ++pageReadGeneration.current;
    setSnapshot(first);
    setOlderPages([]);
    setBefore(first.page.next_before);
    return () => { ++loadGeneration.current; ++pageReadGeneration.current; };
  }, [id, item, first]);
  React.useEffect(() => {
    if (!pageReady) void readSelectedPage();
    return () => { ++loadGeneration.current; ++pageReadGeneration.current; };
  }, [readSelectedPage]);
  React.useEffect(() => (left ? undefined : onStoreChange(reload)), [reload, left]);
  // Open is seen: whatever was new here is marked seen, and again whenever something new arrives while it is open.
  const unread = snapshot.space.unread;
  // When the reader last looked, as this opened: what arrived after it is marked new until they open it again.
  const seenAt = React.useRef<number | null>(snapshot.space.seen_at ? Date.parse(snapshot.space.seen_at) : unread > 0 ? 0 : null);
  React.useEffect(() => {
    if (unread > 0 && !left) { sendQuietly({ key: `space-seen:${id}`, path: `${at(id)}/seen`, body: {} }); }
  }, [id, unread, left]);
  const pictureOf = usePictureUrls([snapshot.space]);

  // A pursuit's own tours are not things among its things (space-kinds.json draws_as `tour`); they are offered below.
  const items = React.useMemo(() => reconcileLoadedSpaceItems(page, olderPages).filter(item => kindOf(item.kind).draws_as !== 'tour'), [page, olderPages]);
  // The tours this pursuit carries for its members, read once per pursuit and offered to the page's tour host, which
  // starts one whose trigger matches this pursuit's opening (its first, once per member).
  React.useEffect(() => {
    if (!TOUR_KINDS.length) return undefined;
    let current = true;
    void readSpaceListPage(at(id), readJson<Page>, { kinds: TOUR_KINDS }).then(found => {
      if (!current) return;
      offerWalkthroughDefinitions(found.items.filter(item => !item.withdrawn && !item.hidden)
        .map(item => (item.body && typeof item.body === 'object' ? (item.body as { tour?: unknown }).tour : null)));
    }, () => {});
    return () => { current = false; };
  }, [id]);
  const byId = React.useMemo(() => new Map(items.map(item => [item.item_id, item])), [items]);
  // Which view of the space's things each list place has open (a feed, the chat, the table); a place not named keeps
  // the person's own choice.
  const [placeViews, setPlaceViews] = React.useState<Record<string, string>>({});

  const readOlder = React.useCallback(async () => {
    if (!before || !pageReady) return;
    const load = loadGeneration.current;
    const request = ++pageReadGeneration.current;
    const cursor = before;
    try {
      const next = await readSpaceListPage(at(id), readJson<Page>, { kinds: selectedKinds, before: cursor });
      if (load !== loadGeneration.current || request !== pageReadGeneration.current) return;
      setOlderPages(current => [...current, { before: cursor, page: next }]);
      setBefore(next.next_before);
    } catch (error) {
      if (load === loadGeneration.current && request === pageReadGeneration.current) notify(errorWords(error), { kind: 'error' });
    }
  }, [before, id, selectedPageKey, pageReady]);

  // Open shows the thing on its own screen for every kind: its file, transcript and media when it carries a file, else its words.
  const openItem = React.useCallback(async (item: Item) => {
    setOpened({ item });
  }, [id]);
  const goTo = React.useCallback((next: string) => { if (next !== current) openPlace(id, snapshot.space.title, next); }, [id, current, snapshot.space.title]);

  // A reply or any action the message box takes is written in Conversation, wherever it was chosen.
  const composing = React.useRef<Pending | null>(null);
  const verbs = React.useMemo<Verbs>(() => ({
    'open-item': async context => { await openItem(context.item as Item); },
    'open-space': () => undefined,
    'open-rules': () => goTo('rules'),
    left: () => setLeft(true),
  }), [openItem, goTo]);
  const actions = useActions(verbs, reload, setPlanNeeded);
  // The store answers each change with the words it refused it with, shown where the change was made.
  const saying = React.useCallback(async (path: string, body: unknown) => {
    try { await postJson(`${at(id)}/${path}`, body); } catch (error) { notify(errorWords(error), { kind: 'error' }); return; }
    await reload();
  }, [id, reload]);
  const setMemberType = React.useCallback((member: Member, type: string) => { void saying('members/type', { member_id: member.member_id, member_type: type }); }, [saying]);
  React.useEffect(() => {
    if (actions.composing && actions.composing !== composing.current) setCurrent('conversation');
    composing.current = actions.composing;
  }, [actions.composing]);

  // After its own places, the ones its turned-on parts and added tools add; a place that is gone (turned off) shows
  // Messages. Every read of the turned-on parts is handed to the sidebar, so the pursuit's rows follow it.
  const added = partPlaces(id, snapshot.community);
  const shown = PLACES.some(one => one.id === current) || added.some(one => one.id === current) ? current : 'conversation';
  const showView = React.useCallback((view: CommunityView) => setSnapshot(was => ({ ...was, community: view })), []);
  React.useEffect(() => { if (snapshot.community) rememberParts(id, snapshot.community); }, [id, snapshot.community]);

  if (planNeeded) return <ScreenState state={planState(planNeeded)} />;
  if (left) return <ScreenState state={{ status: 'empty', icon: 'DoorOpen', title: `You left ${space.title}`, description: 'Someone in it can invite you again.', action: { label: 'Open your pursuits', run: openSpacesList } }} />;

  // Every press in the feed is looked up here: each post's menu rows by their id, its card's Open and Show older by
  // the action itself.
  const pressRuns = new WeakMap<object, (values: Record<string, string>) => unknown>();
  const menuRuns = new Map<string, () => void>();
  const pressAction = (label: string, run: () => void): ThreadAction => { const action = { label }; pressRuns.set(action, run); return action; };
  const itemMenu = (item: Item) => offeredAt('item', itemContext(base, item)).map(action => {
    const key = `${item.item_id}:${action.id}`;
    menuRuns.set(key, () => actions.begin(action, itemContext(base, item), Boolean(action.confirm)));
    return { id: key, label: action.label, icon: action.icon, ...(action.tone ? { tone: action.tone } : {}), ...(action.confirm ? { confirm: words(action.confirm, itemContext(base, item)) } : {}) };
  });
  const openAction = shows('item').find(action => action.road.kind === 'screen');
  // A reaction given or taken back runs the space's react action (space-actions.json, shown at `reaction`) with the
  // chosen symbol or glyph, and the press waits for it, so the chip shows its own work.
  const reactionFor = (item: Item): Pick<ThreadPost, 'react' | 'reactions' | 'palette'> => {
    const react = offeredAt('reaction', itemContext(base, item))[0];
    if (!react || item.withdrawn) return item.reactions?.length ? { reactions: item.reactions } : {};
    const action: ThreadAction = { label: react.label };
    pressRuns.set(action, values => actions.perform(react, { ...itemContext(base, item), asked: { on: values.on !== 'false', ...(values.symbol ? { symbol: values.symbol } : {}), ...(values.glyph ? { glyph: values.glyph } : {}) } }));
    return { react: action, reactions: item.reactions ?? [], palette: reactionChoices.palette };
  };
  const postFor = (item: Item, replies: ThreadPost[]): ThreadPost => {
    const kind = kindOf(item.kind);
    const shown = itemWords(item);
    const source = item.kind === 'message' && item.body && typeof item.body === 'object' ? item.body as { app?: unknown; speaker?: unknown } : null;
    const sourceApp = typeof source?.app === 'string' && source.app.trim() ? source.app.trim() : '';
    const sourceSpeaker = typeof source?.speaker === 'string' && source.speaker.trim() ? source.speaker.trim() : '';
    const sourceTag = sourceSpeaker
      ? `${sourceSpeaker === 'person' ? 'Human' : sourceSpeaker === 'ai' ? 'AI' : sourceSpeaker}${sourceApp ? ` · ${sourceApp}` : ''}`
      : undefined;
    const post: ThreadPost = {
      id: item.item_id, author: item.provenance.by, you: item.provenance.by_you, ...(sourceTag ? { tag: sourceTag } : item.provenance.by_you ? { tag: 'You' } : {}),
      when: when(item.provenance.added_at), body: kind.draws_as === 'conversation' ? shown.text || shown.title : kind.posted_as,
      mentions: kind.draws_as === 'conversation' ? keptMentions((item.body as { mentions?: unknown } | null)?.mentions) : [],
      menu: itemMenu(item), replies, ...reactionFor(item),
      ...(item.part?.quote ? { part: { quote: item.part.quote } } : {}),
    };
    if (item.hidden && item.body === null) return { ...post, body: '', menu: itemMenu(item), withdrawn: `${item.hidden.by} hid this · ${when(item.hidden.at)}` };
    if (item.hidden) post.tag = 'Hidden';
    if (item.withdrawn) return { ...post, body: '', menu: [], withdrawn: `${item.withdrawn.by === space.members.find(member => member.you)?.name ? 'You' : item.withdrawn.by} took this back · ${when(item.withdrawn.at)}` };
    if (kind.draws_as === 'conversation') return post;
    return {
      ...post,
      attachment: {
        kind: kind.label, title: shown.title, ...(shown.detail ? { detail: shown.detail } : {}), preview: previewOf(item, itemBytes(id, item)),
        ...(openAction ? { open: pressAction(openAction.label, () => actions.begin(openAction, itemContext(base, item))) } : {}),
      },
    };
  };

  const composer = actions.composing ?? (() => { const write = offeredAt('composer', base)[0]; return write ? { action: write, context: base } : null; })();
  const chip = composer?.action.box?.chip ? words(composer.action.box.chip, composer.context) : null;
  // The shared composer's message (parts/ui/show/composer): its files are kept in the person's Files, each shared
  // into this space, then the words go by the composer action's own road with those files in its about.
  const send = async (draft: ComposerDraft, parent?: string) => {
    if (!composer) return;
    // Advice before the send, said once: someone it is for is outside working hours, or is not in this pursuit (quiet-send-check.ts).
    const advice = await quietHold(id, draft.mentions);
    if (advice) throw new Error(advice);
    const kept = await keepFiles(draft);
    const shared = await shareKeptFiles(id, kept, postJsonByKey);
    const said = wordsWithLinks(draft);
    if (said) await actions.composed(composer, said, shared, draft.mentions, parent, parent ? byId.get(parent) : undefined);
    else await reload();
    // An AI at work here that the message mentions is handed the message as a job, so it picks it up now.
    for (const mention of draft.mentions.filter(one => mentionKinds[one.kind]?.hands_off)) {
      await postJson(`${at(id)}/handoffs`, { job: said, request_key: crypto.randomUUID(), to_agent: mention.value });
    }
    actions.setComposing(null);
  };
  const attach = offeredAt('attach', base);

  const thingRows: Thing[] = items.map(item => {
    const source = item.kind === 'message' && item.body && typeof item.body === 'object' ? item.body as { app?: unknown; speaker?: unknown } : null;
    const speaker = typeof source?.speaker === 'string' ? source.speaker : '';
    const body = item.body && typeof item.body === 'object' ? item.body as Record<string, unknown> : {};
    const writer = WRITTEN_BY.map(field => body[field]).find((value): value is string => typeof value === 'string' && value.trim() !== '');
    // A writer named with their address ("Dana Ruiz <dana@example.com>") reads as the name alone; a bare address stays.
    const writerName = writer?.replace(/\s*<[^<>]*>\s*$/, '').replace(/^"(.*)"$/, '$1').trim() || writer;
    return {
      id: item.item_id, item, bytes: itemBytes(id, item), kind: item.kind, title: item.withdrawn ? 'Taken back' : itemWords(item).title,
      words: item.withdrawn ? '' : itemWords(item).text, by: item.provenance.by_you ? 'You' : item.provenance.by, author: writerName ?? item.provenance.by,
      sender: speaker === 'person' ? 'Human' : speaker === 'ai' ? 'AI' : speaker,
      source_app: typeof source?.app === 'string' ? source.app : '',
      origin: ORIGINS[item.provenance.origin] ?? readable(item.provenance.origin), when: Date.parse(item.provenance.added_at),
      replies_to: item.reply_to && byId.get(item.reply_to) ? itemWords(byId.get(item.reply_to) as Item).title : '',
      state: item.withdrawn ? 'Taken back' : '',
      facts: item.facts ?? {},
    };
  });

  // How the space's messages nest: each message holds the replies naming it (reply_to), in the one group model every
  // view reads (Chat and Feed nest by it, the Tree outlines it).
  const messageNesting = { graph: items.reduce((graph, item) => {
    if (!item.reply_to || !byId.has(item.reply_to)) return graph;
    const ref = (id: string) => ({ family: 'space-item', parts: { id } });
    try { return addMember(ensureGroup(graph, ref(item.reply_to)), ref(item.reply_to), ref(item.item_id), { memberId: item.item_id }); } catch { return graph; }
  }, emptyGraph()) };
  const headerActions = offeredAt('header', base);
  const menu = menuRows(offeredAt('menu', base), base);
  const header = (
    <CollectionHeader
      title={space.title}
      inset="list"
      mark={{ picture: pictureOf(space), letters: lettersOf(space.title), colour: space.colour }}
      {...(space.description ? { lead: space.description } : {})}
      people={space.members.map((member, index) => ({ key: `${index}:${member.name}`, node: <PersonTag name={member.name} size="sm" /> }))}
      onPeople={() => goTo('people')}
      actions={headerActions.map(action => ({ id: action.id, label: action.label, icon: action.icon, ...(action.primary ? { primary: true } : {}) }))}
      menu={menu.rows}
      onAction={(chosen: string) => {
        // A menu row (its own confirm already asked) or one of its choices; else a header button folded into the menu.
        const row = menu.runs.get(chosen);
        if (row) { actions.begin(row.action, row.chosen ? { ...base, chosen: row.chosen } : base, Boolean(row.action.confirm)); return; }
        const action = ACTIONS.find(one => one.id === chosen);
        if (action) actions.begin(action, base);
      }}
    />
  );

  // The space's things are one list (one item id each), and every way of reading them is a view of it: the feed with
  // the box on top, the chat with the box under it, the table, cards and board, and every view a list is offered
  // (parts/ui/show/record-views/designs). A place naming `views` is that list, narrowed to its `kinds` when it names
  // some (Files is the space's files); which views lead, in which order, is space-kinds.json `places` DATA.
  const offeredHere = viewsOfferedToEveryList(THING_FIELDS);
  const viewsOf = (row: ListPlace): RecordView[] => (row.views ?? []).flatMap(view => {
    const offered = offeredHere.find(one => one.id === view.id);
    return offered ? [offered] : view.label ? [{ id: view.id, label: view.label, icon: view.icon }] : [];
  });
  const votesOn = snapshot.community?.feed !== undefined;
  const vote = (item: Item) => {
    const yours = item.votes?.yours ?? 0;
    return pressAction(yours > 0 ? 'Take my vote back' : 'Vote for this', () => {
      void postJson(`/community/${encodeURIComponent(id)}/posts/${encodeURIComponent(item.item_id)}/vote`, { votes: yours > 0 ? -1 : 1 })
        .then(reload, error => notify(errorWords(error), { kind: 'error' }));
    });
  };
  // What each thing adds where a view draws it as a post: who wrote it, its tag, its menu, a shared thing's card, its
  // mentions, a vote where the space counts votes, or the quiet line of something taken back.
  const postExtras = (row: Thing): Record<string, unknown> => {
    const { replies: _replies, ...post } = postFor(row.item, []);
    // New to the reader: someone else's, written after the reader last looked (the seen time read when this opened).
    const unseen = !row.item.provenance.by_you && seenAt.current !== null && Date.parse(row.item.provenance.added_at) > seenAt.current;
    return { ...post, ...(unseen ? { unseen: true } : {}), ...(votesOn && !row.item.withdrawn ? { score: row.item.votes?.count ?? 0, voted: (row.item.votes?.yours ?? 0) > 0, vote: vote(row.item) } : {}) };
  };
  const compose = composer ? {
    label: composer.action.label,
    send: async ({ text, parent }: { text: string; parent?: string }) => { await actions.composed(composer, text, [], [], parent, parent ? byId.get(parent) : undefined); },
    // A chat's Reply hands the box the message it answers (`reply`): what is sent goes under it.
    box: (reply?: { parent: string; done: () => void }) => (
      <Composer
        onSend={async draft => { await send(draft, reply?.parent); reply?.done(); }}
        readLink={readPastedLink}
        mentions={mentions} mentionKinds={mentionKinds} onMentionQuery={onMentionQuery}
        words={{ label: composer.action.label, placeholder: words(composer.action.box?.placeholder, composer.context) }}
        actions={attach.map(action => ({ id: action.id, label: action.label, icon: action.icon }))}
        onAction={chosen => { const action = attach.find(one => one.id === chosen); if (action) actions.begin(action, base); }}
        {...(chip ? { context: [{ id: composer.action.id, label: chip, icon: composer.action.icon }], onRemoveContext: () => actions.setComposing(null) } : {})}
      />
    ),
  } : undefined;
  // A place naming `views` is the space's one list, narrowed to its `kinds` when it names some; its posts take
  // comments on some of their words and reactions from anywhere on them (src/workspace/responses.tsx reads
  // data-response-space and each post's data-post).
  const listPlace = (row: ListPlace) => {
    if (!pageReady) return <ScreenState state={pageFailed
      ? { status: 'failed', title: `${row.label} could not load`, retry: { label: 'Try again', run: () => { void readSelectedPage(); } } }
      : { status: 'loading', label: `Loading ${row.label.toLowerCase()}`, layout: 'gallery' }} />;
    const rows = row.kinds ? thingRows.filter(thing => row.kinds!.includes(thing.kind)) : thingRows;
    return (
      // Each place is its own list (keyed by the place), so it opens on its own view, not the last place's.
      <Container key={row.id} layout="vertical" flex="1" minHeight="0" overflow="y-auto" padding="md" data-response-space={space.space_id} data-response-audience={`Everyone in ${space.title}`}>
        <RecordChipProvider {...chips}>
          <RecordViews
            label={row.label}
            fields={THING_FIELDS}
            records={rows}
            nesting={messageNesting}
            identify={(thing: Thing) => thing.id}
            preferenceKey={row.remember_as ?? `trillion-space-${row.id}`}
            views={viewsOf(row)}
            {...(placeViews[row.id] ? { view: placeViews[row.id] } : {})}
            onViewChange={(view: string) => setPlaceViews(views => ({ ...views, [row.id]: view }))}
            timeline={{ fieldId: 'when', levels: timelineLevels as never }}
            {...recordFilter}
            onOpen={(thingId: string) => { const item = byId.get(thingId); if (item && !item.withdrawn) void openItem(item).catch(error => notify(errorWords(error), { kind: 'error' })); }}
            rowActions={rowActions<Thing>('item', thing => itemContext(base, thing.item), actions, thingId => rows.find(thing => thing.id === thingId))}
            {...(compose && row.compose ? { compose } : {})}
            designExtras={(_design: string, thing: Thing) => postExtras(thing)}
            designAction={(action: { id?: string; label: string }, values: Record<string, string>) => (pressRuns.get(action) ?? menuRuns.get(action.id ?? ''))?.(values)}
            {...(before ? { toolbarStart: olderToolbar(readOlder) } : {})}
            {...(reveal ? { reveal } : {})}
            emptyMessage={rows.length ? 'Nothing matches.' : row.empty ?? 'Nothing here yet.'}
          />
        </RecordChipProvider>
      </Container>
    );
  };
  const places: Record<string, () => React.ReactNode> = {
    people: () => (
      <Container layout="vertical" flex="1" minHeight="0" gap="lg" overflow="y-auto">
      <Records
        label="People"
        fields={memberFields(space, setMemberType)}
        records={space.members.map((member, index) => ({ ...member, id: `member:${index}` }))}
        identify={(row: Member & { id: string }) => row.id}
        preferenceKey="trillion-space-people"
        views={[{ id: 'table', label: 'Table', icon: 'List' }]}
        {...recordFilter}
        rowActions={rowActions<Member & { id: string }>('member', row => ({ ...base, member: row }), actions, memberId => space.members.map((member, index) => ({ ...member, id: `member:${index}` })).find(row => row.id === memberId))}
        {...(offeredAt('people', base)[0] ? { primaryAction: { label: offeredAt('people', base)[0].label, icon: offeredAt('people', base)[0].icon, onSelect: () => actions.begin(offeredAt('people', base)[0], base) } } : {})}
        emptyMessage="Nobody matches."
      />
      {invites.length ? (
        <Records
          label="Invite links you made"
          fields={INVITE_FIELDS}
          records={invites}
          identify={(row: Invite) => row.invite_id}
          preferenceKey="trillion-space-invites"
          views={[{ id: 'table', label: 'Table', icon: 'List' }]}
          {...recordFilter}
          rowActions={rowActions<Invite>('invite', row => ({ ...base, invite: row }), actions, inviteId => invites.find(row => row.invite_id === inviteId))}
          emptyMessage="No invite link matches."
        />
      ) : null}
      </Container>
    ),
    rules: () => {
      const data = ruleBuilderData(rules, null);
      const typeSpace = { ...(base.space as Record<string, unknown>), member_types: rules.member_types };
      const typeBase = { ...base, community: snapshot.community, space: typeSpace };
      const typeRows = rules.member_types.map(type => ({ ...type, id: type.id }));
      const addType = offeredAt('rules', typeBase).find(action => action.id === 'add-member-type');
      const addCommunityType = offeredAt('rules', typeBase).find(action => action.id === 'add-community-member-type');
      return (
        <Container layout="vertical" flex="1" minHeight="0" gap="md" overflow="y-auto" padding="md">
          <Text variant="body" color="muted">
            {rules.broken ?? (rules.may_change
              ? 'A rule that stops something wins over one that lets it; anything no rule lets is not allowed.'
              : 'A rule that stops something wins over one that lets it; anything no rule lets is not allowed. Only someone these rules let change them can.')}
          </Text>
          <Text variant="body" color="muted">
            {`Each type can inherit permissions from other types. New people start as ${typeLabel({ ...space, member_types: rules.member_types }, space.joins_as ?? '')}. Invite links can give another type when the rules allow it. ${space.label === 'community' ? 'Community roles can be changed by someone allowed to change community settings.' : 'Pursuit-owned types can be renamed, changed or removed here.'}`}
          </Text>
          <Records
            label="Member types"
            fields={memberTypeFields({ ...space, member_types: rules.member_types })}
            records={typeRows}
            identify={(row: MemberType) => row.id}
            preferenceKey="trillion-space-member-types"
            views={[{ id: 'table', label: 'Table', icon: 'List' }]}
            rowActions={rowActions<MemberType>('member-type', type => ({ ...typeBase, member_type: type }), actions, typeId => typeRows.find(type => type.id === typeId))}
            {...(addType || addCommunityType ? { primaryAction: { label: (addType ?? addCommunityType)!.label, icon: (addType ?? addCommunityType)!.icon, onSelect: () => actions.begin((addType ?? addCommunityType)!, typeBase) } } : {})}
            emptyMessage="No member types are available."
          />
          <RuleBuilder
            {...data}
            rules={rules.rules}
            operators={ruleOperators as never}
            readOnly={!rules.may_change}
            problems={ruleProblems}
            onSave={async changed => {
              try {
                await postJson(`${at(id)}/rules`, { rules: changed });
              } catch (error) {
                setRuleProblems((error as { problems?: RuleBuilderProblem[] }).problems ?? []);
                throw error;
              }
              setRuleProblems([]);
              await reload();
            }}
            {...(rules.as_started ? {} : { onRestore: async () => { await postJson(`${at(id)}/rules`, { rules: null }); setRuleProblems([]); await reload(); } })}
          />
        </Container>
      );
    },
    agents: () => (
      <Container layout="vertical" flex="1" minHeight="0" gap="lg" overflow="y-auto">
        {mine?.can_add?.length ? (
          <Container layout="horizontal" padding="md" gap="sm" alignItems="center">
            <ActionMenu
              label="Add one of my AIs"
              items={mine.can_add.map(ai => ({ id: ai.ai_id, label: ai.name, icon: 'Bot' }))}
              onAction={aiId => void addAi(aiId)}
              align="start"
              trigger={<Button size="sm" variant="outline" />}
              triggerContent="Add one of my AIs"
            />
          </Container>
        ) : null}
        {aiRows.length ? (
          <Records
            label="AIs in this space"
            fields={AI_FIELDS}
            records={aiRows}
            identify={(row: SpaceAi) => row.id}
            preferenceKey="trillion-space-ais"
            views={[{ id: 'table', label: 'Table', icon: 'List' }]}
            {...recordFilter}
            emptyMessage="No AI matches."
          />
        ) : null}
        {space.agents.length ? (
          <Records
            label="Agents here"
            fields={AGENT_FIELDS}
            records={space.agents}
            identify={(row: Agent) => row.agent_id}
            preferenceKey="trillion-space-agents"
            views={[{ id: 'table', label: 'Table', icon: 'List' }, { id: 'gallery', label: 'Cards', icon: 'LayoutGrid' }]}
            {...recordFilter}
            rowActions={rowActions<Agent>('agent', row => ({ ...base, agent: row }), actions, agentId => space.agents.find(row => row.agent_id === agentId))}
            emptyMessage="No agent matches."
          />
        ) : null}
        {handoffs.length ? (
          <Records
            label="Work handed over"
            fields={workFields(space.agents)}
            records={handoffs}
            identify={(row: Handoff) => row.handoff_id}
            preferenceKey="trillion-space-work"
            views={[{ id: 'table', label: 'Table', icon: 'List' }, { id: 'board', label: 'Board', icon: 'Columns3' }]}
            {...recordFilter}
            emptyMessage="No work matches."
          />
        ) : null}
        {/* One empty state, only when nothing at all is here: never beside rows that are. */}
        {aiRows.length || space.agents.length || handoffs.length ? null : <ScreenState state={{ status: 'empty', icon: 'Bot', title: 'No AI is in this pursuit yet', description: 'The AIs each person here connects to Trillion show here, and the work they pick up here shows with them.' }} />}
      </Container>
    ),
  };

  return (
    <Container layout="vertical" flex="1" minHeight="0" height="full" gap="none">
      {header}
      {opened ? (
        <Container layout="vertical" flex="1" minHeight="0" gap="sm" padding="md">
          <Container layout="horizontal" gap="sm" alignItems="center">
            <Button size="sm" variant="ghost" onClick={() => setOpened(null)}>Back</Button>
            <Text variant="heading-xs" truncate>{itemWords(opened.item).title}</Text>
          </Container>
          <Container layout="vertical" flex="1" minHeight="0" overflow="y-auto">
            <React.Suspense fallback={null}><OpenedSharedRecord key={`${id}:${opened.item.item_id}`} item={opened.item} spaceId={id} spaceTitle={space.title}
              wordsOf={record => itemWords(record as Item).detail || itemWords(record as Item).text} /></React.Suspense>
          </Container>
        </Container>
      ) : places[shown] ? places[shown]() : PLACES.find(row => row.id === shown)?.views ? listPlace(PLACES.find(row => row.id === shown)!) : PLACES.find(row => row.id === shown)?.screen ? <ScreenPlace key={shown} id={id} tool={PLACES.find(row => row.id === shown)!.screen!} />
        : added.find(one => one.id === shown)?.tool_id ? <ScreenPlace key={shown} id={id} tool={added.find(one => one.id === shown)!.tool_id!} />
        : <TurnedOnPlace key={shown} id={id} place={shown} {...(lesson && shown === 'classroom' ? { lesson } : {})} onView={showView} onPlace={setCurrent} />}
      <AskPanel actions={actions} />
      <Picker actions={actions} beside={attach} />
    </Container>
  );
}

/** A place whose space-kinds.json row names a tool's screen (`screen`): that tool's own screen, opened on this space
 *  (`space_id`) by the one tool screen host (tool-screen.tsx) with the workspace's own screens, both fetched when such
 *  a place first opens. */
function ScreenPlace({ id, tool }: { id: string; tool: string }) {
  const host = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const element = host.current;
    if (!element) return undefined;
    let unmount: (() => void) | null = null;
    let gone = false;
    void Promise.all([import('./tool-screen'), import('./screen-mounts')]).then(([module, mounts]) => { if (!gone) unmount = module.mountToolScreen(element, { surfaceInput: { tool_id: tool, space_id: id } }, mounts.screens); });
    return () => { gone = true; unmount?.(); };
  }, [id, tool]);
  return <Container ref={host} layout="vertical" flex="1" minHeight="0" />;
}

/** One place a space's turned-on parts add, drawn by community-screen.tsx into a host held here; each read it makes
 *  updates the space (and its rows in the sidebar), and a press inside it that goes to another place (See the
 *  leaderboard, a tool's Open) shows that place here. */
function TurnedOnPlace({ id, place, lesson, onView, onPlace }: { id: string; place: string; lesson?: LessonRoute; onView: (view: CommunityView) => void; onPlace: (place: string) => void }) {
  const host = React.useRef<HTMLDivElement>(null);
  const latest = React.useRef({ onView, onPlace });
  latest.current = { onView, onPlace };
  React.useEffect(() => {
    if (!host.current) return undefined;
    return mountCommunityPlace(host.current, { id, place, ...(lesson ? { lesson } : {}), onView: view => latest.current.onView(view), onPlace: next => latest.current.onPlace(next) });
  }, [id, place, lesson?.course_id, lesson?.lesson_id]);
  return <Container ref={host} layout="vertical" flex="1" minHeight="0" overflow="y-auto" />;
}

// Show older in the Everything list's own toolbar row: one mount per page cursor.
const olderToolbars = new WeakMap<() => Promise<void>, (host: HTMLElement) => () => void>();
function olderToolbar(readOlder: () => Promise<void>) {
  let mount = olderToolbars.get(readOlder);
  if (!mount) {
    mount = (host: HTMLElement) => mountReactSurface(host, <Button size="sm" variant="ghost" onClick={() => readOlder()}>Show older</Button>);
    olderToolbars.set(readOlder, mount);
  }
  return mount;
}

export function mountSpaceScreen(element: HTMLElement, props: { surfaceInput?: Record<string, unknown> }): () => void {
  const id = typeof props.surfaceInput?.id === 'string' ? props.surfaceInput.id : '';
  const item = typeof props.surfaceInput?.item === 'string' ? props.surfaceInput.item : undefined;
  const requestedCourse = typeof props.surfaceInput?.course_id === 'string' ? props.surfaceInput.course_id.slice(0, 200) : '';
  const requestedLesson = typeof props.surfaceInput?.lesson_id === 'string' ? props.surfaceInput.lesson_id.slice(0, 200) : '';
  const requestedLessonRoute = requestedCourse && requestedLesson ? { course_id: requestedCourse, lesson_id: requestedLesson } : undefined;
  let unmountView: (() => void) | null = null;
  let drawnAs: 'space' | 'outside' | null = null;
  // The place the tab is on (its sidebar row's input); a space opened on one of its messages opens where its messages
  // are, and an address without a place opens the turned-on place it asks for, else Messages.
  const asked = typeof props.surfaceInput?.place === 'string' ? props.surfaceInput.place : '';
  const place = item ? 'conversation' : requestedLessonRoute ? 'classroom' : asked || openingPlace(id);
  const space = { content: element };

  const OPEN_LIST = { label: 'Open your pursuits', run: openSpacesList };
  if (!id) mountScreenState(space.content, { status: 'empty', icon: 'UsersRound', title: 'No pursuit was named', description: 'Open one from your pursuits.', action: OPEN_LIST });
  const screen = id ? loadScreen(space.content, {
    loading: { label: 'Loading this pursuit', layout: 'rows' },
    // Someone not in the space sees what it shows everyone, with how to join, when it shows anything at all.
    read: async (): Promise<Snapshot | { outside: CommunityView } | null> => {
      const found = await readAnswer<Space>(at(id));
      if (!found.ok && (found.status === 400 || found.status === 403 || found.status === 404)) {
        const outside = await readTurnedOn(id);
        return outside && !outside.you.member ? { outside } : null;
      }
      if (!found.ok) throw Object.assign(new Error(found.error), { status: found.status });
      // The first page read is already the tab's own place's (Files reads only files).
      return readSpace(id, item, PLACES.find(row => row.id === place)?.kinds);
    },
    empty: first => (first ? null : { status: 'empty', icon: 'UserX', title: 'You are not in this pursuit', description: 'You may have left it, or the link was for someone else. Open your pursuits to see the ones you are in.', action: OPEN_LIST }),
    failed: (error, retry) => failedState(error, retry, 'This pursuit could not load', OPEN_LIST),
    clear: () => { unmountView?.(); unmountView = null; drawnAs = null; },
    // The space reads itself again from here on (SpaceView); this draws it once. Seen from outside, it is its first
    // turned-on place with Join, and joining draws the space itself.
    draw: first => {
      if (!first) return;
      const as = 'outside' in first ? 'outside' : 'space';
      if (unmountView && drawnAs === as) return;
      unmountView?.();
      drawnAs = as;
      if ('outside' in first) {
        unmountView = mountCommunityPlace(space.content, { id, place: requestedLessonRoute ? 'classroom' : OUTSIDE_PLACE, ...(requestedLessonRoute ? { lesson: requestedLessonRoute } : {}), onView: view => { if (view.you.member) void screen?.reload(); }, onPlace: () => undefined });
        return;
      }
      // Opening a space you are in makes the whole workspace about it: every screen (the Calendar, Files, Decisions...)
      // narrows to it until the Focus changes (scope-focus.ts, the sidebar's switcher).
      // The pursuit itself is named (the room stands for it, src/record-scope.mjs), so the switcher reads its title.
      const pursuit = (first.space as { pursuit_id?: string }).pursuit_id;
      void (pursuit ? focusOn(spaceKinds.focus_param, pursuit) : focusOn(spaceKinds.room_focus_param, id)).catch(() => undefined);
      unmountView = mountReactSurface(space.content, <SpaceView id={id} first={first} {...(item ? { item } : {})} place={place} {...(requestedLessonRoute ? { lesson: requestedLessonRoute } : {})} />);
    },
  }) : null;
  return () => { screen?.dispose(); unmountView?.(); };
}
