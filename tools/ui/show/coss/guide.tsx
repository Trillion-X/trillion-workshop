// parts/ui/show/coss/guide.tsx
//
// PURPOSE
//   One guide screen drawn from DATA: a title and lead, optional progress, then sections that each may carry numbered
//   steps (with a done state, a copyable line, labelled notes such as what to leave alone or what shows when it
//   worked, a link and one action), tabs of steps (one per choice, such as each AI
//   app, drawn as equal tiles in a grid, each with its `picture` logo or `icon`), a `fan` (logo-fan.tsx: one mark among
//   others as a picture), cards (a job with an example, its actions and optionally a copy button), and rows (an item with a status, actions, and optionally
//   its own numbered steps and boxes behind a disclosure, its logo, and the accounts under it with their own actions
//   shown on hover or focus). A section's `stats` are number tiles (stat-tiles.tsx), its `thread` a discussion with
//   nested replies and votes (thread.tsx), its `ranks` a numbered list of people (rank-list.tsx). Its `profile` is a person at a glance
//   (profile-card.tsx), its `banner` one line across its top with its `explain` button at the end (banner.tsx), its
//   `explain` a "learn more" card that opens in place (explain-card.tsx), its `table` people by place in columns
//   (rank-table.tsx) and its `courses` cards with parts to finish (course-cards.tsx). Its `people` are people as cards with
//   labelled lists and their own actions (person-cards.tsx), and its `chain` people in one line from top to bottom with
//   the caller's word between each two (chain-list.tsx). A description's `aside` sections sit
//   in a sticky column beside the main ones on a wide pane and after them on a narrow one; `hide_header` leaves the
//   title out when the host already names the screen. A section's `catalog` turns its rows into a list a person can search, filter by any fact
//   and sort, through the shared record views (record-views/record-views.tsx) over each row's `facts`. Anatomy follows 21st.dev's "Use 21st in your agent" page
//   (tab per client, numbered install steps, copyable code, "Copy as prompt", job cards with "Copy prompt for your
//   agent"), its onboarding step dots and Settings > Security list; Mobbin references are recorded in the Trillion
//   README's screen contract. Controls are the licensed Coss sources (Button, Badge, Input); appearance lives in
//   screen-look/show/guide.css.
//
// NON-NEGOTIABLE INVARIANTS
//   1. There are no section kinds: every part of a section is optional DATA and a section draws the parts it has.
//   2. This file knows no product words and no addresses. What an action does is the caller's (`onAction`); this file
//      only reports which action was chosen, with the typed values of the row it sits in when the action asks for them.
//   3. An action that names `confirm` asks in place, never in a modal: the first press shows the question and turns the
//      button into its confirmation; the second press acts. An action that names `ask` asks for one value the same way:
//      the first press shows its box (starting at `ask.value`), the second sends what was typed under `values[ask.name]`.
//   4. A value typed into a box is kept only in this component's state until its action is chosen, and the boxes are
//      emptied after the action answers. A field that chooses (`kind: 'choice'`) or picks (`kind: 'pick'`) starts at
//      the value the row gives it and goes back to it after the action answers; nothing is ever typed there
//      (pick-field.tsx), and a field hidden by its `shows_when` sends nothing. A file field (`kind: 'file'`) holds only
//      the id of a file the guide's source listed or uploaded (file-field/FileField.tsx), or a list of those ids when
//      `multiple`; `file_source` names a source in the guide's `fileSources`, never an address. Nothing is typed there.
//   5. A revealed value (a new key, a saved password) is shown once, with a copy button, under the row, item or section
//      whose action asked for it, until it is hidden or, when the answer names `hide_after_seconds`, until that many
//      seconds have passed. It is held under the action that asked (useReveals) in a store outside the drawing
//      (guideReveals; a screen passes its own as `reveals`), never by the component whose button was pressed, so the
//      redraw its own answer asks for (`refresh`) cannot drop it even when that redraw draws the row, or the whole
//      guide, again; it still hides at the time it was first shown.
//   6. A link to another site is a real link that opens a new tab; it never depends on script to open.
//   7. A row whose own action already starts it (a Connect button) has no second button to open its steps: the
//      disclosure arrow opens them. Only a row with no action of its own shows its open button (`open_label`).
//   8. A catalog never keeps a copy of the rows: the list below its search is the section's own rows in the order and
//      selection the record views chose, so an open row keeps its typed boxes while the person searches.
//   9. A list of rows (a section's rows, a catalog's list view) draws only the rows in reach and more as the person
//      scrolls (rows-in-reach), so a section of hundreds of rows never draws them all at once; search and filter still
//      read every row, and a row opened from the table is always drawn.
//  10. A pressed action's work is drawn by the shared Button alone (one loading mark with the action's `busy_label`,
//      then a check): the guide adds no loading mark of its own and does not disable the button itself, so the button
//      keeps its raised look, its size and its place from the press until its own label returns.
//
// KEY CONCEPTS
//   `GuideAction`: { label, tone?, busy_label?, href?, open?, copy?, queue?: { job, context }, send?: { path, body?, confirm?,
//   with_fields?, ask? } } — `copy` is copied by the guide's own copy button (copy-button), which says Copied on itself;
//   the caller decides what `href`, `open`, `queue` and `send` mean (`queue` names a job
//   the caller hands to the person's own AIs, with its context); a card's `actions` are drawn under it the same way; tone is a plain word (primary, quiet, danger);
//   `busy_label` says in plain words what is happening while the action runs.
//   `tool: { id, input?, with_fields? }` runs a published tool through the host's existing Workshop client; typed
//   fields are merged into its input only when explicitly requested, with the same permission/conflict rules as AI runs.
//   `learn: { title, body?, steps? }` makes the action a Learn more button: it sends nothing and opens its steps in a floating
//   panel (no backdrop, the page behind stays usable), so a card explains itself without leaving the page.
//   A section's `offer` is one offer as a card (offer-card.tsx): a price and a feature list whose opening words are
//   bold; its `empty` says, with an icon, that a list holds nothing yet (the shared EmptyState); its `choose` is one
//   pick among open times (the shared TimeSlotPicker): the section's actions that send fields send the pick under
//   `choose.name` and wait for one; an action marked `full` is the section's main one, drawn large across the column;
//   its `footnote` is said under its actions. A description's `announce` ({ id, text }) is for the host to say once.
//   A row's `drag` lets it be dragged onto another row whose `drop` accepts its kind (a drive onto a drive): the row it
//   is over lights up, and dropping asks in place (`drop.confirm`), then sends the chosen drop action with the dragged
//   row's value under `dropped`; Cancel puts it back. The same work stays reachable without dragging through the row's
//   own fields and actions.

import {useRecordConfigurations, type RecordConfigurationBinding} from '../record-views/use-record-configurations';
import guideProgress from './guide-progress.json';
import * as React from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { EmptyState } from '../empty-state';
import { StepMark, stepMarkState } from '../step-mark';
import { Button } from './ui/button';
import { Badge, badgeVariantForTone } from './ui/badge';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Switch } from './ui/switch';
import { Checkbox } from './ui/checkbox';
import { ChoiceField, PickList, type PickOption } from './pick-field';
import type { FileFieldSource } from '../file-field';
// Record selection arrives only when a guide opens a field that asks for it.
const RecordPicker = lazyPart(() => import('../record-picker/RecordPicker'), module => module.RecordPicker);
import type { RecordFrom, RecordNew, RecordSource, RecordSuggestion } from 'trillion-workshop/tools/ui/show/record-picker/record-value.ts';
import { NamedIcon } from '../icon/NamedIcon';
import { AutomationPreview } from '../automation-preview/AutomationPreview';
import { CopyButton } from '../copy-button/CopyButton';
import { ChoiceTiles } from '../choice-tiles/ChoiceTiles';
import { rememberChoice, rememberedChoice } from '../choice-tiles/remembered-choice';
import { openChoice, type OpenableChoice } from '../choice-tiles/OpenChoice';
import { mountReactSurface } from '../react-surface-mount/mount-react-surface';
import { Spinner } from '../spinner/Spinner';
import { TimeSlotPicker, type TimeSlotDay } from './time-slot-picker';
import { StatTiles, type StatTile } from './stat-tiles';
import type { TrendLine } from './trend-lines';
import { UsageMeter, type UsageSegment } from '../usage-meter/UsageMeter';
import { ShareSheet, type SharePlace, type ShareWords } from '../share-card/ShareSheet';
import { LinkShareSheet, type LinkShare } from '../share-card/LinkShareSheet';
import type { ShareCard } from '../share-card/share-card';
import type { ThreadDescription } from './thread';
import { later, lazyPart } from '../load-later/later';
// A guide's file picker, trend lines and threads are fetched when a guide first draws one, never with its screen.
const FileField = later(() => import('../file-field'), module => module.FileField);
const TrendLines = later(() => import('./trend-lines'), module => module.TrendLines);
const Thread = later(() => import('./thread'), module => module.Thread);
import { RankList, type RankRow } from './rank-list';
import { Logo } from './logo';
import { LogoFan, type LogoFanDescription } from './logo-fan';
import { ProfileCard } from './profile-card';
import { RankTable } from './rank-table';
import { CourseCards } from './course-cards';
import { PersonCards } from './person-cards';
import { ChainList } from './chain-list';
import { OfferCard } from './offer-card';
import { Banner } from './banner';
import { Explain, ExplainPanel, ExplainToggle, useExplain } from './explain-card';
import { RecordViews, type FieldDescriptor, type RecordViewsOptions } from '../record-views/record-views';
import { ScanCode } from '../scan-code/ScanCode';
import { useRowsInReach } from '../rows-in-reach';
import { FloatingPanel } from '../../../screen-arrangement/show/FloatingPanel';

export type GuideTone = string;
/** `icon` is a NamedIcon name drawn before the label; `icon_only` shows just the icon, with the label as its name and
 *  hover title; `full` draws it large across the whole column (a section's one main action, such as paying). `switch` draws the action as an on/off switch labelled `label`; flipping it runs the action (whose
 *  `send` says what the flip does), and a `confirm` is asked in place before it turns on. */
export type GuideAction = { label: string; tone?: GuideTone; busy_label?: string; icon?: string; icon_only?: boolean; full?: boolean; switch?: { on: boolean }; href?: string; open?: string; tour?: string; copy?: string; tool?: { id: string; input?: Record<string, unknown>; with_fields?: boolean; field_paths?: Record<string, string[]>; request_key_field?: string }; share?: { record: string; title?: string }; queue?: { job: string; context: Record<string, string> }; send?: { path: string; body?: Record<string, unknown>; confirm?: string; with_fields?: boolean; ask?: GuideAsk; selection?: string }; learn?: GuideLearn };
/** What a Learn more button opens: a floating panel with a title, a line, and steps (the same steps a row opens), so a card can explain itself without leaving the page. */
export type GuideLearn = { title: string; body?: string; steps?: GuideStep[] };
/** The one value an action asks for in place before it sends (a new name): its box's label and starting words. */
export type GuideAsk = { name: string; label: string; value?: string };
/** One pick among open times, drawn by the shared TimeSlotPicker; `chosen` is a pick already made. */
export type GuideChoice = { name: string; label: string; days: TimeSlotDay[]; chosen?: string };
/** A row's field: a box to type in (no `kind`; it starts at `value` when one is given, so an edit form opens on what is saved), one choice among `options` (`kind: 'choice'`, starting at `value`),
 *  several picked with a plus (`kind: 'pick'`, starting at `values`), or one of the person's files (`kind: 'file'`,
 *  of the kind `takes` names in file-field/file-takes.json, chosen from the guide's `files` or dropped or uploaded;
 *  its value is the file's id). `shows_when` shows the field only while another field of the row holds one of `values`. */
export type GuideField = { name: string; label: string; secret?: boolean; placeholder?: string; kind?: 'choice' | 'pick' | 'file' | 'text' | 'record'; from?: RecordFrom; new?: RecordNew; suggestions?: RecordSuggestion[]; options?: PickOption[]; value?: string; values?: string[]; add_label?: string; takes?: string; multiple?: boolean; file_source?: string; input_contract?: string; shows_when?: { name: string; values: string[] }; before_steps?: boolean; submit?: boolean };
/** What a row's fields hold when its action sends them: typed and chosen values as text, picked ones as a list. */
export type GuideValues = Record<string, string | string[]>;
/** The fields a person fills in to finish a step here (src/setup-policy.json `complete_here`): sent with `action` as
 *  `{ step, values }`, where `values` holds each field's text by its name. A `required` field must be typed first. */
export type GuideCompleteHere = { step: string; action: string; label: string; fields: { name: string; label: string; required?: boolean; placeholder?: string }[]; values?: Record<string, string> };
/** A step in a list (a setup screen's card). `done` null is not known yet and draws a calm checking mark. `owner` says who
 *  does the step next, drawn as a quiet line while it is not done. `items` are the things a step has (accounts, AIs),
 *  drawn as chips with their logo, status and action; `add` is the step's button after them; `progress` is the step's
 *  own measured part (a bar and its label). */
export type GuideStepItem = { name: string; logo?: string; status?: { label: string; tone?: GuideTone }; action?: GuideAction };
export type GuideStep = { title: string; body?: string; code?: string; notes?: { label: string; text: string }[]; link?: { label: string; href: string }; action?: GuideAction; actions?: GuideAction[]; done?: boolean | null; owner?: 'you' | 'ai'; items?: GuideStepItem[]; add?: GuideAction; progress?: { done: number; total: number; label: string }; place?: string; shows_when?: { name: string; values: string[] }; complete_here?: GuideCompleteHere };
export type GuideCard = { title: string; body?: string; icon?: string; example?: string; copy?: { label: string; text: string }; actions?: GuideAction[] };
/** One thing under a row (an account connected to a service), its actions shown when it is hovered or focused. */
/** Something automatic that stands behind an item (a rule, a schedule, a workflow), by the id its hover card reads. */
export type GuideAutomation = { id: string; label: string; on?: boolean };
export type GuideItem = { id: string; title: string; detail?: string; status?: { label: string; tone?: GuideTone }; automations?: GuideAutomation[]; actions?: GuideAction[] };
/** `children` are rows revealed inside their parent; they reuse the same disclosure and within-reach rendering at
 *  every level. Opening or hiding a subtree changes only local presentation, never runs an action. */
/** `open_label` names the button that opens a row's steps or boxes (default "Set up"); `starts_open` shows them at once.
 *  `logo` is a picture address (a letter tile stands in when it is missing or does not load); `facts` are what a
 *  section's catalog searches, filters and sorts by, keyed by its field ids. */
/** A row that can be dragged (`drag`: what kind of thing it is and the value it carries) and one that takes such a drop
 *  (`drop`: the kind it accepts, the words asked in place with {from} and {to} filled from the two rows' titles, and its
 *  actions, each sent with the dragged row's value under `dropped` in its body once the person presses it). */
export type GuideDrag = { kind: string; value: Record<string, unknown> };
export type GuideDrop = { accepts: string; confirm?: string; actions: GuideAction[] };
export type GuideRow = { id: string; pick?: string; title: string; record?: string; share_record?: string; record_open?: string; detail?: string; automations?: GuideAutomation[]; automations_inside?: boolean; logo?: string; facts?: Record<string, string | string[]>; status?: { label: string; tone?: GuideTone }; items?: GuideItem[]; children?: GuideRow[]; steps?: GuideStep[]; fields?: GuideField[]; actions?: GuideAction[]; open_label?: string; starts_open?: boolean; drag?: GuideDrag; drop?: GuideDrop; scan?: GuideScan };
/** A code another device scans to open the row's link (an app for a phone, offered on a computer): the picture's
 *  address and the words under it. */
export type GuideScan = { src: string; label: string };
/** A section's rows as a searchable list: `fields` are record-view field descriptors (DATA: id, label, icon, kind,
 *  ruleKind, filterable, groupable, sortable, width, values) read from each row's `facts`. */
/** A catalog field is a record-views field descriptor as DATA; `leading: 'logo'` draws the row's logo before its value. */
/** `view` is the view it opens on (`list`, `table`, `gallery`, `board`; the list when left out). */
export type GuideCatalog = { configuration?: {target: string; open_path: string}; label: string; fields: (Omit<FieldDescriptor, 'read' | 'render' | 'renderGroup' | 'factValue' | 'sortValue' | 'pickValues' | 'countValue' | 'load' | 'cardOverlay'> & { leading?: 'logo'; fact_from?: string })[]; empty?: string; view?: string; selection?: GuideAction[] };
/** One choice of several, drawn as a tile: `picture` is its logo's address and `icon` a NamedIcon for a choice with no
 *  logo; with neither, the tile shows a quiet app glyph. */
/** `copy` is put on the clipboard when the tab is picked, and the tab itself says it was copied (`copied_label`).
 *  `open` is where the pick goes at once, holding those words (the AI app, open with its input filled, so Send is all
 *  that is left; an address that takes no words has the words already copied).
 *  `remember` keeps the pick as the person's choice under that name (../choice-tiles remembered choice), so the tabs open
 *  on it and every Ask your AI button names it; `actions` sit above the tab's steps. */
export type GuideTab = { id: string; label: string; picture?: string; icon?: string; lead?: string; copy?: { text: string; copied_label: string }; remember?: string; open?: { href: string; paste?: boolean }; actions?: GuideAction[]; steps: GuideStep[] };
/** A person at a glance (profile-card.tsx): name and a small tag beside it, a line under it, a bar toward something
 *  (`meter`: its label, e.g. a level, the words at its two ends, and how far along from 0 to 1), labelled facts, one
 *  highlighted fact in its own tile, and one action along the foot. */
/** `mark` draws a face before the name: a person's picture, or their initials when it has none (the shared person mark,
 *  show/display-mark), or a thing's `icon`. Left out, the profile has no face: a tool or a run is named, never given a
 *  made-up one. */
export type GuideProfile = {
  name: string; tag?: string; detail?: string;
  mark?: { picture?: string; icon?: string };
  meter?: { label: string; progress: number; start?: string; end?: string };
  facts?: { label: string; value: string; icon?: string }[];
  highlight?: { title: string; value?: string; detail?: string; icon?: string };
  action?: GuideAction;
};
/** One line across the top of a section (the reader's own standing, a summary): an icon, a title with a line under
 *  it, a value at the right. The section's `explain` opens under it. */
export type GuideBanner = { icon?: string; title: string; value?: string; detail?: string };
/** A table of people or things by place (rank-table.tsx): the columns after the place and name, each row's cells by
 *  column id, the reader's own row lit, and a quiet line where places are left out (`gap`, drawn after that place). */
export type GuideTable = {
  columns: { id: string; label: string; align?: 'start' | 'end'; accent?: boolean }[];
  name_label?: string;
  rows: { id: string; place?: number; name: string; tag?: string; detail?: string; highlight?: boolean; cells: Record<string, string>; action?: GuideAction }[];
  gap?: { after_place: number; text: string };
  empty?: string;
};
/** Cards in a grid, each a course or anything with parts to finish (course-cards.tsx): a title, a line, how far along
 *  (`done` of `of`, drawn as a bar with its words), a status, and the action that opens it. */
export type GuideCourse = { id: string; title: string; about?: string; icon?: string; done?: number; of?: number; progress_label?: string; status?: { label: string; tone?: GuideTone }; action?: GuideAction };
/** "Learn more" that opens in place, never in a modal (explain-card.tsx): a title and line, numbered cards, and a
 *  ladder of named rungs with the reader's own rung lit. `label` names the button that opens it. */
export type GuideExplain = {
  label: string; title: string; lead?: string;
  steps?: { title: string; body?: string }[];
  ladder?: { label: string; note?: string; rungs: { name: string; detail?: string; current?: boolean }[] };
};
/** A person as a card (person-cards.tsx): name, a small tag beside it, a status, a line under it, labelled lists (one
 *  line per item, or `chips`; `empty` is said while a list has nothing yet), and the card's own actions. */
export type GuidePerson = { id: string; name: string; tag?: string; detail?: string; highlight?: boolean; status?: { label: string; tone?: GuideTone }; lists?: { label?: string; items: string[]; style?: 'lines' | 'chips'; empty?: string }[]; actions?: GuideAction[] };
/** People in one line from top to bottom (chain-list.tsx): `between` is the word drawn between two links, a link's
 *  `badge` a title that stands out, its `highlight` the reader's own. */
export type GuideChain = { label?: string; between?: string; links: { id: string; name: string; tag?: string; detail?: string; highlight?: boolean; badge?: { label: string; icon?: string } }[] };
/** One offer as a card: a small title, its price and how often it is paid, and its features, each one line whose
 *  `lead` (its opening words) is bold and whose `rest` finishes it. */
export type GuideOffer = { title?: string; price?: string; price_note?: string; features: { lead: string; rest?: string }[] };
/** What an empty list says: a NamedIcon, what is not there yet, and what will fill it. */
export type GuideEmpty = { icon?: string; title: string; body?: string };
/** `profile`, `banner`, `explain`, `table` and `courses` are drawn in that order after the heading and body; a
 *  `thread` whose `style` is 'cards' draws each post as its own card (a feed) rather than one continuous discussion. */
/** `part` names a part the host lends (GuideOptions.parts): the section draws it under its heading and body, and the
 *  part keeps its own state (a look chooser reading the person's records). */
export type GuideSection = { id?: string; heading?: string; body?: string; part?: string; prompt?: { label: string; text: string }; profile?: GuideProfile; banner?: GuideBanner; explain?: GuideExplain; table?: GuideTable; courses?: GuideCourse[]; people?: GuidePerson[]; chain?: GuideChain; offer?: GuideOffer; empty?: GuideEmpty; fan?: LogoFanDescription; steps?: GuideStep[]; tabs?: GuideTab[]; tabs_require_choice?: boolean; cards?: GuideCard[]; stats?: StatTile[]; split?: GuideSplit; trends?: TrendLine[]; share?: GuideShare; link_share?: LinkShare; thread?: ThreadDescription; ranks?: RankRow[]; rows?: GuideRow[]; catalog?: GuideCatalog; choose?: GuideChoice; actions?: GuideAction[]; note?: string; footnote?: string };
/** A whole cut into its parts (the shared usage meter): one bar of proportional segments with a legend naming each
 *  part's amount and share. `total` is the whole when it is more than the parts. */
export type GuideSplit = { label: string; total?: number; segments: UsageSegment[] };
/** `aside` sections sit in a column beside the main ones on a wide screen and after them on a narrow one. `hide_header`
 *  leaves the title and lead out when the host already names the screen (an inner sidebar's heading). `narrowed` says
 *  the screen was cut down to what an address named: it draws one button (its label) that calls the host's `widen`. */
/** `progress` draws one mark per item, for a short list of steps; `badge` is one count or state beside the title (the
 *  shared Badge), for a list too long to draw item by item. */
export type GuideDescription = { title: string; lead?: string; hide_header?: boolean; narrowed?: { label: string }; aside?: GuideSection[]; progress?: { done: number; total: number; label?: string }; badge?: { label: string; tone?: GuideTone }; announce?: { id: string; text: string }; sections: GuideSection[] };
/** A value shown once: its label, its words, and how many seconds it stays before it hides itself (stays when left out). */
export type GuideReveal = { label: string; text: string; hide_after_seconds?: number };
/** What the caller does with a chosen action. `values` holds the row's typed boxes when the action sends them. */
export type GuideActionHandler = (action: GuideAction, values: GuideValues) => Promise<GuideReveal | void> | GuideReveal | void;
// Presentation may adapt an action's tone or add the person's values. Keep its
// callable identity separate from that prepared description.
const actionOrigins = new WeakMap<GuideAction, GuideAction>();
export const guideActionSource = (action: GuideAction): GuideAction => actionOrigins.get(action) ?? action;
const adaptAction = (action: GuideAction, changes: Partial<GuideAction>): GuideAction => {
  const prepared = { ...action, ...changes };
  actionOrigins.set(prepared, guideActionSource(action));
  return prepared;
};
/** What the host lends a catalog: the formula engine's rule filter, so a catalog offers Filter. Without it a catalog
 *  still searches and sorts. */
/** A card of numbers to share: the card, the words it is sent with, where pressing Share sends it (`send.path`, answered
 *  with `{ url, text }`), and the places it can go. */
export type GuideShare = { card: ShareCard; text: string; send: { path: string }; destinations: SharePlace[]; words: ShareWords };
/** `post` sends a share's card to its `send.path` and returns the answer; without it a share section shows no sheet. */
/** `parts` maps a section's `part` name to the component the host lends for it; a section naming a part the host did
 *  not lend shows nothing for it. */
/** `files` is where a file field lists the person's files from and uploads a dropped one to. */
/** The values a guide shows right now, by the action that asked for each (invariant 5). A screen that may draw its
 *  guide anew (a kept copy replaced by a different answer) makes one with `guideReveals()` and hands it to every
 *  guide it draws, so a value revealed just before that redraw is still shown after it. */
export type GuideReveals = {
  read: () => Record<string, ShownReveal>;
  keep: (key: string, reveal: GuideReveal | null) => void;
  subscribe: (listener: () => void) => () => void;
};
type ShownReveal = { reveal: GuideReveal; until: number | null };
export function guideReveals(): GuideReveals {
  let shown: Record<string, ShownReveal> = {};
  const listeners = new Set<() => void>();
  return {
    read: () => shown,
    keep(key, reveal) {
      const next = { ...shown };
      if (reveal) next[key] = { reveal, until: reveal.hide_after_seconds ? Date.now() + reveal.hide_after_seconds * 1000 : null };
      else delete next[key];
      shown = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

export type GuideOptions = { configurations?: RecordConfigurationBinding; recordFilter?: Pick<RecordViewsOptions, 'ruleOperators' | 'loadFilterRecords'>; post?: (path: string, body: Record<string, unknown>) => Promise<{ url: string; text?: string }>; parts?: Record<string, React.ComponentType>; files?: FileFieldSource; fileSources?: Record<string, FileFieldSource>; records?: RecordSource; reveals?: GuideReveals; place?: (address: string) => React.ReactNode; widen?: () => void };
const GuideOptionsContext = React.createContext<GuideOptions>({});

const RevealsContext = React.createContext<GuideReveals | null>(null);
const revealKey = (action: GuideAction) => JSON.stringify([action.send?.path ?? null, action.send?.body ?? null, action.label]);
/** The reveal shown for any of `actions`, how to keep one an action answered with, and how to hide it. */
function useReveals(actions: GuideAction[] = []) {
  const store = React.useContext(RevealsContext)!;
  const shown = React.useSyncExternalStore(store.subscribe, store.read, store.read);
  const key = actions.map(revealKey).find(candidate => shown[candidate]);
  const reveal = key ? shown[key] : null;
  const keepFor = (action: GuideAction) => (answer: GuideReveal | void) => { if (answer) store.keep(revealKey(action), answer); };
  const hide = React.useCallback(() => { if (key) store.keep(key, null); }, [key, store]);
  return { reveal, keepFor, hide };
}

const BUTTON_VARIANT: Record<string, 'default' | 'outline' | 'ghost' | 'destructive-outline'> = { primary: 'default', quiet: 'outline', danger: 'destructive-outline', plain: 'ghost', 'plain-danger': 'ghost' };
// The yes of a confirm wears red only when the action itself is destructive; confirming any other change is the strong action.
const confirmTone = (tone?: string) => (tone === 'danger' || tone === 'plain-danger' ? 'danger' : 'primary');

function Status({ status, className }: { status: { label: string; tone?: GuideTone }; className: string }) {
  const tone = status.tone ?? 'quiet';
  // A done status (tone good) wears the shared step mark, the same tick every done step wears, never a dot of its own colour.
  const mark = tone === 'good' ? <StepMark className="guide-status-mark" state="done" n={0} /> : <span className="guide-status-dot" aria-hidden />;
  return <Badge variant={badgeVariantForTone(tone)} className={`guide-status ${className}`} data-tone={tone}>{mark}{status.label}</Badge>;
}

function CodeLine({ text }: { text: string }) {
  return (
    <div className="guide-code">
      <pre className="guide-code-text"><code>{text}</code></pre>
      <CopyButton text={text} iconOnly />
    </div>
  );
}

function ActionSwitch({ action, onAction, onDone }: { action: GuideAction & { switch: { on: boolean } }; onAction: GuideActionHandler; onDone?: (reveal: GuideReveal | void) => void }) {
  const [asking, setAsking] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  // A link that leaves this page in this tab (a service's sign-in page the Worker has to prepare first) says it is on
  // its way, and still working when that takes long, until the page goes; coming back to this page lets go.
  const [going, setGoing] = React.useState(false);
  React.useEffect(() => {
    if (!going) return undefined;
    const back = () => setGoing(false);
    window.addEventListener('pageshow', back);
    return () => window.removeEventListener('pageshow', back);
  }, [going]);
  const confirm = action.send?.confirm;
  const run = async () => {
    setAsking(false);
    setBusy(true);
    // The press always reaches the handler; only what it shows afterwards depends on onDone. (An optional call
    // skips its arguments when onDone is absent, which is how a card's buttons once did nothing.)
    try { const reveal = await onAction(action, {}); onDone?.(reveal); } finally { setBusy(false); }
  };
  return (
    <span className="guide-action guide-switch">
      <label className="guide-switch-label">
        <Switch checked={action.switch.on} disabled={busy} onCheckedChange={() => { if (confirm && !action.switch.on && !asking) setAsking(true); else void run().catch(() => {}); }} />
        <span>{action.label}</span>
      </label>
      {asking ? <span className="guide-confirm" role="status">{confirm}</span> : null}
      {asking ? <Button type="button" size="default" variant="outline" onClick={() => run()}>Turn on</Button> : null}
      {asking ? <Button type="button" size="default" variant="ghost" onClick={() => setAsking(false)}>Keep it off</Button> : null}
    </span>
  );
}

// A guide drawn inside a card that shows one thing alone (the held card: `.queue-card[data-alone]`; a different React
// root than this guide, so the card is found in the page) never draws a switch: the do-it is a press, and the card has
// ONE strong action. A press of the section's own actions (`.guide-section-actions`) is that action (primary); a row's
// switch becomes its own press, primary only when the section has no press of its own and no switch before it claimed
// it, otherwise a plain outline press. A switch already on has nothing left to do (the row's status says so), so it
// draws nothing.
const claimedDoIt = new WeakMap<Element, true>();
function useAloneCard(): { ref: React.RefObject<HTMLSpanElement | null>; card: Element | null; primary: boolean; section: boolean } {
  const ref = React.useRef<HTMLSpanElement | null>(null);
  const [found, setFound] = React.useState<{ card: Element | null; primary: boolean; section: boolean }>({ card: null, primary: false, section: false });
  React.useLayoutEffect(() => {
    const card = ref.current?.closest('.queue-card[data-alone]') ?? null;
    if (!card) return undefined;
    const section = Boolean(ref.current?.closest('.guide-section-actions'));
    const ownsSection = Boolean(card.querySelector('.guide-section-actions'));
    const primary = section || (!ownsSection && !claimedDoIt.has(card));
    if (primary) claimedDoIt.set(card, true);
    setFound({ card, primary, section });
    return () => { if (primary) claimedDoIt.delete(card); };
  }, []);
  return { ref, ...found };
}

type ActionButtonProps = { action: GuideAction; onAction: GuideActionHandler; values?: GuideValues; onDone?: (reveal: GuideReveal | void) => void; disabled?: boolean };
function ActionButton(props: ActionButtonProps) {
  const { ref, card, primary, section } = useAloneCard();
  const { action } = props;
  const plain = action.copy !== undefined || action.icon_only || action.href !== undefined || action.tone === 'plain' || action.tone === 'plain-danger';
  let drawn: React.ReactNode;
  // A destructive press (delete, remove) never belongs on a card that shows one thing alone.
  if (card && (action.tone === 'danger' || action.tone === 'plain-danger')) drawn = null;
  else if (card && action.switch) {
    drawn = action.switch.on ? null : <PressButton action={adaptAction(action, { switch: undefined, tone: primary ? 'primary' : 'quiet' })} onAction={props.onAction} values={props.values ?? {}} onDone={props.onDone} disabled={props.disabled ?? false} />;
  } else if (card && section && primary && !plain) {
    drawn = <ActionButtonOf {...props} action={adaptAction(action, { tone: 'primary' })} />;
  } else drawn = <ActionButtonOf {...props} />;
  // The queue's own finish reads this mark: one strong action per card (OneAtATimeQueue invariant 11).
  const strong = Boolean(card && drawn && primary && !plain);
  return <span ref={ref} className="guide-do-it" data-primary-do-it={strong ? 'true' : undefined}>{drawn}</span>;
}

function ActionButtonOf({ action, onAction, values = {}, onDone, disabled = false }: { action: GuideAction; onAction: GuideActionHandler; values?: GuideValues; onDone?: (reveal: GuideReveal | void) => void; disabled?: boolean }) {
  if (action.switch) return <ActionSwitch action={action as GuideAction & { switch: { on: boolean } }} onAction={onAction} onDone={onDone} />;
  // An action whose DATA is `copy` copies on the button itself, which says Copied (the shared copy part).
  if (action.learn) return <LearnButton action={action} learn={action.learn} onAction={onAction} />;
  if (action.copy !== undefined) return <CopyButton text={action.copy} label={action.label} iconOnly={action.icon_only} variant={BUTTON_VARIANT[action.tone ?? 'quiet'] ?? 'outline'} size={action.icon_only ? 'icon-sm' : 'default'} />;
  return <PressButton action={action} onAction={onAction} values={values} onDone={onDone} disabled={disabled} />;
}

// Learn more: one button that opens its explanation in a floating panel (no backdrop; the page behind stays usable),
// drawn from the same steps a row opens. It sends nothing: the steps' own actions run through `onAction` as anywhere.
function LearnButton({ action, learn, onAction }: { action: GuideAction; learn: GuideLearn; onAction: GuideActionHandler }) {
  const [open, setOpen] = React.useState(false);
  return (
    <span className="guide-action">
      <Button type="button" size={action.icon_only ? 'icon-sm' : 'default'} variant={BUTTON_VARIANT[action.tone ?? 'quiet'] ?? 'outline'} aria-label={action.label} title={action.label} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(current => !current)}>
        {action.icon ? <NamedIcon name={action.icon} aria-hidden className="guide-action-icon" /> : null}
        {action.icon_only ? null : action.label}
      </Button>
      <FloatingPanel open={open} onClose={() => setOpen(false)} title={learn.title} width={460} kind="guide-learn">
        <div className="guide guide-learn">
          {learn.body ? <p className="guide-learn-body">{learn.body}</p> : null}
          {learn.steps?.length ? <Steps steps={learn.steps} onAction={onAction} /> : null}
        </div>
      </FloatingPanel>
    </span>
  );
}

function PressButton({ action, onAction, values, onDone, disabled }: { action: GuideAction; onAction: GuideActionHandler; values: GuideValues; onDone?: (reveal: GuideReveal | void) => void; disabled: boolean }) {
  const [asking, setAsking] = React.useState(false);
  // A link that leaves this page in this tab (a service's sign-in page the Worker has to prepare first) says it is on
  // its way, and still working when that takes long, until the page goes; coming back to this page lets go.
  const [going, setGoing] = React.useState(false);
  React.useEffect(() => {
    if (!going) return undefined;
    const back = () => setGoing(false);
    window.addEventListener('pageshow', back);
    return () => window.removeEventListener('pageshow', back);
  }, [going]);
  const confirm = action.send?.confirm;
  const ask = action.send?.ask;
  const [typed, setTyped] = React.useState(ask?.value ?? '');
  const askButton = React.useRef<HTMLButtonElement>(null);
  // The promise this returns is the button's work (invariant 10): the shared Button draws it, so nothing here does.
  // The press that only asks first (a confirmation, a value) does no work, so it returns none and the button says
  // nothing has been done yet.
  const run = () => {
    if ((confirm || ask) && !asking) { setTyped(ask?.value ?? ''); setAsking(true); return undefined; }
    return send();
  };
  const send = async () => {
    if (ask && !typed.trim()) return;
    if (!ask) setAsking(false);
    const sent = ask ? adaptAction(action, { send: { ...action.send!, with_fields: true } }) : action;
    const reveal = await onAction(sent, ask ? { [ask.name]: typed.trim() } : values);
    if (ask) setAsking(false);
    onDone?.(reveal);
  };
  if (ask && asking) {
    return (
      <span className="guide-action guide-ask">
        <Input aria-label={ask.label} placeholder={ask.label} autoFocus value={typed} onChange={event => setTyped(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); askButton.current?.click(); } else if (event.key === 'Escape') setAsking(false); }} />
        <Button ref={askButton} type="button" size="default" variant={BUTTON_VARIANT.primary ?? 'default'} disabled={!typed.trim()} onClick={run}>{action.label}</Button>
        <Button type="button" size="default" variant="ghost" onClick={() => setAsking(false)}>Cancel</Button>
      </span>
    );
  }
  const linked = typeof action.href === 'string';
  const external = linked && /^https?:\/\//.test(action.href);
  // An address into an app on the person's computer (cursor://, claude-cli://) leaves this page where it is: nothing
  // to wait for, so the button never shows it as going somewhere.
  const appLink = linked && !external && /^[a-z][a-z0-9+.-]*:\/\//i.test(action.href);
  if (linked && !confirm && !ask) {
    return (
      <span className="guide-action">
        <Button size="default" variant={BUTTON_VARIANT[action.tone ?? 'quiet'] ?? 'outline'} disabled={disabled} work={going ? 'pending' : null} pendingLabel={action.busy_label ?? action.label}
          onClick={external || appLink ? undefined : () => setGoing(true)} render={<a href={action.href} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})} />}>
          {action.label}
          {external ? <ExternalLink aria-hidden className="guide-action-icon" /> : null}
        </Button>
      </span>
    );
  }
  return (
    <span className={action.full ? 'guide-action guide-action--full' : 'guide-action'}>
      {asking ? <span className="guide-confirm" role="status">{confirm}</span> : null}
      <Button type="button" size={action.icon_only && !asking ? 'icon-sm' : action.full ? 'xl' : 'default'} variant={BUTTON_VARIANT[asking ? confirmTone(action.tone) : action.tone ?? 'quiet'] ?? 'outline'} data-tone={action.tone ?? 'quiet'} title={action.icon_only ? action.label : undefined} aria-label={action.icon_only && !asking ? action.label : undefined} pendingLabel={action.busy_label} disabled={disabled} onClick={run}>
        {action.icon ? <NamedIcon name={action.icon} aria-hidden className="guide-action-icon" /> : null}
        {asking ? `Yes, ${action.label.charAt(0).toLowerCase()}${action.label.slice(1)}` : action.icon_only ? null : action.label}
        {external ? <ExternalLink aria-hidden className="guide-action-icon" /> : null}
      </Button>
      {asking ? <Button type="button" size="default" variant="ghost" onClick={() => setAsking(false)}>Keep it</Button> : null}
    </span>
  );
}

// It hides at the time it was kept with, so drawing it again (a redraw) never shows it longer.
function RevealBox({ shown: { reveal, until }, onHidden }: { shown: ShownReveal; onHidden: () => void }) {
  React.useEffect(() => {
    if (until === null) return undefined;
    const timer = window.setTimeout(onHidden, Math.max(0, until - Date.now()));
    return () => window.clearTimeout(timer);
  }, [until, onHidden]);
  return (
    <div className="guide-reveal" role="status">
      <p className="guide-reveal-label">{reveal.label}</p>
      <CodeLine text={reveal.text} />
    </div>
  );
}

// A step the person finishes right here: its named fields (text boxes) and the button that sends them as `values`. The
// button stays off until every required field has words in it, and the boxes clear once the send is answered.
function CompleteHere({ complete, done, title, onAction }: { complete: GuideCompleteHere; done?: boolean | null; title: string; onAction: GuideActionHandler }) {
  const [editing, setEditing] = React.useState(false);
  React.useEffect(() => { setEditing(false); }, [done]);
  // The boxes start from what Trillion already holds (complete.values), so a saved answer shows and can be changed.
  const starting = React.useCallback((): GuideValues => Object.fromEntries(complete.fields.map(field => [field.name, complete.values?.[field.name] ?? ''])), [complete]);
  const [values, setValues] = React.useState<GuideValues>(starting);
  const action: GuideAction = { label: complete.label, tone: 'primary', send: { path: `/work/api/${complete.action}`, body: { step: complete.step }, with_fields: true } };
  const ready = complete.fields.every(field => !field.required || String(values[field.name] ?? '').trim());
  if (done === true && !editing) return <Button variant="ghost" size="sm" aria-label={`Edit ${title}`} onClick={() => { setValues(starting()); setEditing(true); }}>Edit</Button>;
  return (
    <div className="guide-fields">
      {complete.fields.map(field => (
        <label key={field.name} className="guide-field">
          <span className="guide-field-label">{field.label}</span>
          <Input type="text" autoComplete="off" spellCheck={false} placeholder={field.placeholder} value={String(values[field.name] ?? '')} onChange={event => setValues(now => ({ ...now, [field.name]: event.target.value }))} />
        </label>
      ))}
      <ActionButton action={action} onAction={onAction} values={values} onDone={() => { setValues(starting); setEditing(false); }} disabled={!ready} />
      {done === true ? <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button> : null}
    </div>
  );
}

// A step's items as chips: each one's logo tile, name, status and action. Past CHIP_LIMIT the rest wait behind one
// "+N more" button that shows them all (and "Show fewer" takes them back), so a long list never runs off a phone.
const CHIP_LIMIT = 8;
function StepItems({ items, onAction }: { items: GuideStepItem[]; onAction: GuideActionHandler }) {
  const [all, setAll] = React.useState(false);
  const shown = all ? items : items.slice(0, CHIP_LIMIT);
  return (
    <>
      <ul className="guide-step-items">
        {shown.map((item, index) => (
          <li key={`${index}:${item.name}`} className="guide-chip">
            <Logo src={item.logo} name={item.name} className="guide-chip-logo" />
            <span className="guide-chip-name">{item.name}</span>
            {item.status ? <Status status={item.status} className="guide-chip-status" /> : null}
            {item.action ? <ActionButton action={item.action} onAction={onAction} /> : null}
          </li>
        ))}
      </ul>
      {items.length > CHIP_LIMIT ? <Button type="button" variant="ghost" className="guide-step-more" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `+${items.length - CHIP_LIMIT} more`}</Button> : null}
    </>
  );
}

// A step's own measured part: the progress track the guide's Progress draws, with the step's label under it.
function StepProgress({ progress }: { progress: NonNullable<GuideStep['progress']> }) {
  const total = Math.max(0, Math.floor(progress.total));
  const done = Math.min(Math.max(0, progress.done), total);
  return (
    <div className="guide-step-progress">
      <div className="guide-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label={progress.label}>
        <span className="guide-progress-fill" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
      </div>
      <p className="guide-progress-label">{progress.label}</p>
    </div>
  );
}

// A step with a `place` (an address of the page) draws that screen in place under it when the host lends `place`
// (GuideOptions.place): the first step still to do starts open, the step's own button opens or closes it, one at a
// time, so the person does the step right there and nothing opens beside or over the screen. Without a host `place`
// the step's action opens it the ordinary way. Each mark is the shared step mark.
function Steps({ steps, onAction, values = {}, fields = [] }: { steps: GuideStep[]; onAction: GuideActionHandler; values?: GuideValues; fields?: GuideField[] }) {
  const { place } = React.useContext(GuideOptionsContext);
  const shown = steps.filter(step => visibleWhen(step.shows_when, values, fields));
  const firstToDo = place ? shown.find(step => step.place && step.done !== true)?.place ?? null : null;
  const [chosen, setChosen] = React.useState<string | null | undefined>(undefined);
  const open = chosen === undefined ? firstToDo : chosen;
  return (
    <ol className="guide-steps">
      {shown.map((step, index) => {
        // A done step keeps its screen too (to change a name, add an account): it opens when pressed, never by itself.
        const placed = Boolean(place && step.place);
        const act: GuideActionHandler = (action, given) => (placed && action === step.action ? setChosen(open === step.place ? null : step.place) : onAction(action, given));
        return (
          <li key={`${index}:${step.title}`} className={['guide-step', step.done === true ? 'guide-step--done' : '', step.done === null ? 'guide-step--checking' : ''].filter(Boolean).join(' ')}>
            <StepMark className="guide-step-mark" state={step.done === null ? 'checking' : stepMarkState(step.done)} n={index + 1} />
            <div className="guide-step-content">
              <p className="guide-step-title">
                {step.title}
                {step.done === true ? <span className="guide-visually-hidden"> (done)</span> : null}
              </p>
              {step.body && step.done !== true ? <p className="guide-step-body">{step.body}</p> : null}
              {step.owner && step.done !== true ? <p className="guide-step-owner">{step.owner === 'you' ? 'You' : 'Your AI'}</p> : null}
              {step.progress ? <StepProgress progress={step.progress} /> : null}
              {step.items?.length ? <StepItems items={step.items} onAction={onAction} /> : null}
              {step.code ? <CodeLine text={step.code} /> : null}
              {step.complete_here ? <CompleteHere complete={step.complete_here} done={step.done} title={step.title} onAction={onAction} /> : null}
              {step.link || step.action || step.actions?.length || step.add ? (
                <div className="guide-step-actions">
                  {step.link ? <ActionButton action={{ label: step.link.label, href: step.link.href, tone: 'quiet' }} onAction={onAction} /> : null}
                  {step.action && !(placed && open === step.place) ? <ActionButton action={step.action} onAction={act} /> : null}
                  {step.actions?.map(action => <ActionButton key={action.label} action={action} onAction={onAction} />)}
                  {step.add ? <ActionButton action={step.add} onAction={onAction} /> : null}
                </div>
              ) : null}
              {step.notes?.map(note => <p key={note.label} className="guide-step-note"><span className="guide-step-note-label">{note.label}</span> {note.text}</p>)}
              {placed && open === step.place ? <div className="guide-step-place">{place!(step.place!)}</div> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// Up to `dots_at_most` steps, one dot each; past that a row of dots would run off the screen, so it is one short bar
// filled as far as the person has got (guide-progress.json).
function Progress({ progress }: { progress: NonNullable<GuideDescription['progress']> }) {
  const total = Math.max(0, Math.floor(progress.total));
  const done = Math.min(Math.max(0, progress.done), total);
  const label = progress.label ?? `${done} of ${total}`;
  return (
    <div className="guide-progress">
      {total <= guideProgress.dots_at_most ? (
        <div className="guide-progress-dots" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label={label}>
          {Array.from({ length: total }, (_, index) => <span key={index} className={index < done ? 'guide-progress-dot guide-progress-dot--done' : 'guide-progress-dot'} />)}
        </div>
      ) : (
        <div className="guide-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label={label}>
          <span className="guide-progress-fill" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
        </div>
      )}
      {progress.label ? <p className="guide-progress-label">{progress.label}</p> : null}
    </div>
  );
}

// The tabs: the shared tiles (../choice-tiles) as one tablist, the picked tile's steps below. A tab whose DATA carries
// `remember` keeps the pick as the person's choice under that name (the same choice OpenChoice opens), so the tabs open
// on it; a tab's `actions` (opening that app with the words, say) sit above its steps.
function Tabs({ tabs, onAction, requireChoice = false }: { tabs: GuideTab[]; onAction: GuideActionHandler; requireChoice?: boolean }) {
  const key = tabs.find(tab => tab.remember)?.remember ?? null;
  const [current, setCurrent] = React.useState<string | null>(() => {
    const remembered = key ? rememberedChoice(key) : null;
    return tabs.find(tab => tab.id === remembered)?.id ?? (requireChoice ? null : tabs[0]?.id ?? '');
  });
  const shown = tabs.find(tab => tab.id === current) ?? (requireChoice ? undefined : tabs[0]);
  const pick = (tile: { id: string }) => {
    setCurrent(tile.id);
    const tab = tabs.find(item => item.id === tile.id);
    if (tab?.remember) rememberChoice(tab.remember, tab.id);
    if (tab?.open) void openChoice({ ...tile, ...tab.open } as OpenableChoice, tab.copy?.text ?? '');
  };
  return (
    <div className="guide-tabs">
      <ChoiceTiles kind="tabs" tiles={tabs} chosen={shown?.id ?? null} onPick={pick} />
      {shown ? <div className="guide-tab-panel" role="tabpanel" aria-label={shown.label}>
        {shown.lead ? <p className="guide-tab-lead">{shown.lead}</p> : null}
        {shown.actions?.length ? <div className="guide-tab-actions">{shown.actions.map(action => <ActionButton key={action.label} action={action} onAction={onAction} />)}</div> : null}
        <Steps steps={shown.steps} onAction={onAction} />
      </div> : null}
    </div>
  );
}

function Cards({ cards, onAction }: { cards: GuideCard[]; onAction: GuideActionHandler }) {
  return (
    <div className="guide-cards">
      {cards.map(card => (
        <div key={card.title} className="guide-card">
          {card.icon ? <NamedIcon name={card.icon} className="guide-card-icon" aria-hidden /> : null}
          <p className="guide-card-title">{card.title}</p>
          {card.body ? <p className="guide-card-body">{card.body}</p> : null}
          {card.example ? <p className="guide-card-example">“{card.example}”</p> : null}
          {card.copy ? <CopyButton text={card.copy.text} label={card.copy.label} variant="outline" size="default" className="guide-copy--wide" /> : null}
          {card.actions?.length ? <div className="guide-row-actions">{card.actions.map(action => <ActionButton key={action.label} action={action} onAction={onAction} />)}</div> : null}
        </div>
      ))}
    </div>
  );
}

/** What runs by itself behind a row or item: one quiet line each, with the shared hover card and click-to-edit. */
function Automations({ automations }: { automations?: GuideAutomation[] }) {
  if (!automations?.length) return null;
  return (
    <div className="automation-preview-list" data-guide-automations>
      {automations.map(automation => (
        <AutomationPreview key={automation.id} automationId={automation.id} title={automation.label}>
          <NamedIcon name="Zap" size="xs" aria-hidden/>{automation.label}{automation.on === false ? ' (off)' : ''}
        </AutomationPreview>
      ))}
    </div>
  );
}

function Item({ item, onAction }: { item: GuideItem; onAction: GuideActionHandler }) {
  const { reveal, keepFor, hide: hideReveal } = useReveals(item.actions);
  return (
    <li className="guide-item">
      <div className="guide-item-text">
        <p className="guide-item-title">{item.title}</p>
        {item.detail ? <p className="guide-item-detail">{item.detail}</p> : null}
        <Automations automations={item.automations} />
      </div>
      {item.status ? <Status status={item.status} className="guide-item-status" /> : null}
      {item.actions?.length ? <div className="guide-item-actions">{item.actions.map(action => <ActionButton key={action.label} action={action} onAction={onAction} onDone={keepFor(action)} />)}</div> : null}
      {reveal ? <RevealBox shown={reveal} onHidden={hideReveal} /> : null}
    </li>
  );
}

// A row's fields as they start: each choice at its `value`, each pick at its `values`, each box at its `value` when it
// is given one (filled from what the person typed elsewhere), else empty.
const startingValues = (fields: GuideField[] = []): GuideValues => Object.fromEntries(fields.filter(field => field.kind || field.value !== undefined).map(field => [field.name, field.kind === 'pick' || (field.kind === 'file' && field.multiple) ? field.values ?? [] : field.value ?? '']));
const asList = (value: string | string[] | undefined) => (Array.isArray(value) ? value : []);
// A field that depends on another shows only while that one holds one of its values; a hidden field sends nothing.
const visibleWhen = (condition: GuideField['shows_when'], values: GuideValues, fields: GuideField[], seen = new Set<string>()): boolean => {
  if (!condition) return true;
  if (seen.has(condition.name)) return false;
  const parent = fields.find(field => field.name === condition.name);
  return condition.values.includes(String(values[condition.name] ?? '')) && (!parent || visibleWhen(parent.shows_when, values, fields, new Set([...seen, condition.name])));
};
const shown = (field: GuideField, values: GuideValues, fields: GuideField[]) => visibleWhen(field.shows_when, values, fields);
const sentValues = (fields: GuideField[] = [], values: GuideValues): GuideValues => Object.fromEntries(Object.entries(values).filter(([name]) => { const field = fields.find(item => item.name === name); return !field || (field.submit !== false && shown(field, values, fields)); }));

/** `openAsked` is a count the catalog raises to open this row and bring it into view (a row picked in the table). */
// A row dragged onto another carries its kind in the drag's type (readable while it is over a row, unlike its data), so
// only a row whose `drop` accepts that kind lights up and takes it.
const DRAG_TYPE = 'application/x-trillion-guide-row+';
const dragTypeOf = (kind: string) => `${DRAG_TYPE}${kind.toLowerCase()}`;
type Dropped = { id: string; title: string; value: Record<string, unknown> };

/** What a drop asks in place: its words, then each of its actions (pressed once, busy inside itself) and Cancel. */
function DropAsk({ drop, dropped, title, onAction, onDone }: { drop: GuideDrop; dropped: Dropped; title: string; onAction: GuideActionHandler; onDone: () => void }) {
  const words = (drop.confirm ?? '').replace(/\{from\}/g, dropped.title).replace(/\{to\}/g, title);
  return (
    <div className="guide-drop-ask" role="group" aria-label={words || title}>
      {words ? <span className="guide-drop-words">{words}</span> : null}
      <div className="guide-row-actions">
        {drop.actions.map(action => (
          <ActionButton key={action.label} action={adaptAction(action, { send: action.send ? { ...action.send, confirm: undefined, body: { ...(action.send.body ?? {}), dropped: dropped.value } } : action.send })} onAction={onAction} onDone={onDone} />
        ))}
        <Button type="button" size="default" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}

function Row({ row, onAction, openAsked = 0, picked }: { row: GuideRow; onAction: GuideActionHandler; openAsked?: number; picked?: { on: boolean; set: (on: boolean) => void } }) {
  // A row whose rules sit inside (`automations_inside`) opens to show them with its steps, so they stay out of the list.
  const rulesInside = Boolean(row.automations_inside && row.automations?.length);
  const opens = Boolean(row.steps?.length || row.fields?.length || row.children?.length || rulesInside);
  const disclosureNoun = row.children?.length ? 'details' : 'steps';
  const bodyId = React.useId();
  const [open, setOpen] = React.useState(row.starts_open === true);
  const [values, setValues] = React.useState<GuideValues>(() => startingValues(row.fields));
  const previousFields = React.useRef(row.fields ?? []);
  const liveFields = React.useRef(row.fields);
  liveFields.current = row.fields;
  React.useEffect(() => {
    const previous = new Map(previousFields.current.map(field => [field.name, field]));
    setValues(current => {
      const next = startingValues(row.fields);
      for (const field of row.fields ?? []) {
        if (!Object.prototype.hasOwnProperty.call(current, field.name)) continue;
        const before = previous.get(field.name);
        const contractChanged = before?.input_contract !== undefined && field.input_contract !== undefined
          && before.input_contract !== field.input_contract;
        const controlChanged = before !== undefined && before.kind !== field.kind;
        if (contractChanged || controlChanged) continue;
        const value = current[field.name];
        // A box the person has not changed follows its new starting value; one they changed keeps their words.
        if (before !== undefined && before.value !== field.value && String(value ?? '') === String(before.value ?? '')) continue;
        if (field.kind === 'choice' && value !== '' && !(field.options ?? []).some(option => option.value === String(value))) continue;
        if (field.kind === 'pick' && Array.isArray(value) && field.options?.length) {
          next[field.name] = value.filter(item => field.options!.some(option => option.value === item));
        } else next[field.name] = value;
      }
      return next;
    });
    previousFields.current = row.fields ?? [];
  }, [row.fields]);
  const { reveal, keepFor, hide: hideReveal } = useReveals(row.actions);
  const { files, fileSources, records } = React.useContext(GuideOptionsContext);
  const node = React.useRef<HTMLLIElement>(null);
  const [over, setOver] = React.useState(false);
  const [dropped, setDropped] = React.useState<Dropped | null>(null);
  const takesDrop = (event: React.DragEvent) => Boolean(row.drop) && event.dataTransfer.types.includes(dragTypeOf(row.drop!.accepts));
  React.useEffect(() => {
    if (!openAsked) return;
    if (opens) setOpen(true);
    node.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [openAsked, opens]);
  const done = (action: GuideAction) => (answer: GuideReveal | void) => { setValues(startingValues(liveFields.current)); keepFor(action)(answer); };
  const inline = (row.actions ?? []).filter(action => !opens || !(action.send?.with_fields || action.tool?.with_fields));
  const withFields = (row.actions ?? []).filter(action => opens && (action.send?.with_fields || action.tool?.with_fields));
  const drawFields = (beforeSteps: boolean) => {
    const fields = (row.fields ?? []).filter(field => Boolean(field.before_steps) === beforeSteps && shown(field, values, row.fields ?? []));
    return fields.length ? <div className="guide-fields">{fields.map(field => field.kind === 'record' && field.from ? (
      <div key={field.name} className="guide-field">
        <span className="guide-field-label">{field.label}</span>
        <React.Suspense fallback={<Spinner aria-label={field.label} />}>
        <RecordPicker name={field.name} label={field.label} placeholder={field.placeholder} from={field.from} made={field.new} suggestions={field.suggestions} source={records}
          value={String(values[field.name] ?? '')} onChange={value => setValues(now => ({ ...now, [field.name]: value }))} />
        </React.Suspense>
      </div>
    ) : field.kind === 'file' ? (
      <div key={field.name} className="guide-field">
        <span className="guide-field-label">{field.label}</span>
        {field.multiple
          ? <FileField label={field.label} takes={field.takes} multiple value={asList(values[field.name])} source={field.file_source ? fileSources?.[field.file_source] : files} onChange={value => setValues(now => ({ ...now, [field.name]: value }))} />
          : <FileField label={field.label} takes={field.takes} value={String(values[field.name] ?? '')} source={field.file_source ? fileSources?.[field.file_source] : files} onChange={value => setValues(now => ({ ...now, [field.name]: value }))} />}
      </div>
    ) : (
      <label key={field.name} className="guide-field">
        <span className="guide-field-label">{field.label}</span>
        {field.kind === 'choice' ? <ChoiceField label={field.label} options={field.options ?? []} value={String(values[field.name] ?? '')} onChange={value => setValues(now => ({ ...now, [field.name]: value }))} />
          : field.kind === 'pick' ? <PickList label={field.label} options={field.options ?? []} values={asList(values[field.name])} addLabel={field.add_label ?? field.label} onChange={picked => setValues(now => ({ ...now, [field.name]: picked }))} />
            : field.kind === 'text' ? <Textarea autoComplete="off" spellCheck={false} placeholder={field.placeholder} value={String(values[field.name] ?? '')} onChange={event => setValues(now => ({ ...now, [field.name]: event.target.value }))} />
              : <Input type={field.secret === false ? 'text' : 'password'} autoComplete="off" spellCheck={false} placeholder={field.placeholder} value={String(values[field.name] ?? '')} onChange={event => setValues(now => ({ ...now, [field.name]: event.target.value }))} />}
      </label>
    ))}</div> : null;
  };
  return (
    <li
      className={over ? 'guide-row guide-row--drop-over' : 'guide-row'}
      ref={node}
      draggable={row.drag ? true : undefined}
      data-draggable={row.drag ? '' : undefined}
      onDragStart={row.drag ? event => {
        event.dataTransfer.setData(dragTypeOf(row.drag!.kind), JSON.stringify({ id: row.id, title: row.title, value: row.drag!.value }));
        event.dataTransfer.effectAllowed = 'copyMove';
      } : undefined}
      onDragOver={row.drop ? event => { if (takesDrop(event)) { event.preventDefault(); setOver(true); } } : undefined}
      onDragLeave={row.drop ? event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false); } : undefined}
      onDrop={row.drop ? event => {
        if (!takesDrop(event)) return;
        event.preventDefault();
        setOver(false);
        try {
          const found = JSON.parse(event.dataTransfer.getData(dragTypeOf(row.drop!.accepts))) as Dropped;
          if (found.id !== row.id) setDropped(found);
        } catch { /* a drop that carries nothing readable is ignored */ }
      } : undefined}
    >
      <div className="guide-row-top">
        {picked ? <Checkbox className="guide-row-pick" aria-label={`Pick ${row.title}`} checked={picked.on} onCheckedChange={on => picked.set(on === true)} /> : null}
        {opens ? (
          <Button type="button" variant="ghost" size="icon-sm" className="guide-row-toggle" aria-expanded={open} aria-controls={bodyId} aria-label={open ? `Hide ${row.title} ${disclosureNoun}` : `Show ${row.title} ${disclosureNoun}`} onClick={() => setOpen(!open)}>
            {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
          </Button>
        ) : null}
        {row.logo !== undefined ? <Logo src={row.logo} name={row.title} className="guide-row-logo" /> : null}
        <div className="guide-row-text">
          <p className="guide-row-title">{row.title}</p>
          {row.detail ? <p className="guide-row-detail">{row.detail}</p> : null}
          {rulesInside ? null : <Automations automations={row.automations} />}
        </div>
        {row.status ? <Status status={row.status} className="guide-row-status" /> : null}
        {inline.length ? <div className="guide-row-actions">{inline.map(action => <ActionButton key={action.label} action={action} onAction={onAction} onDone={done(action)} />)}</div> : null}
        {opens && !open && !inline.length ? <Button type="button" size="default" variant="outline" onClick={() => setOpen(true)}>{row.open_label ?? (row.children?.length ? 'Show details' : 'Set up')}</Button> : null}
      </div>
      {row.scan ? <ScanCode src={row.scan.src} label={row.scan.label} className="guide-row-scan" /> : null}
      {dropped && row.drop ? <DropAsk drop={row.drop} dropped={dropped} title={row.title} onAction={onAction} onDone={() => setDropped(null)} /> : null}
      {row.items?.length ? <ul className="guide-items">{row.items.map(item => <Item key={item.id} item={item} onAction={onAction} />)}</ul> : null}
      {reveal ? <RevealBox shown={reveal} onHidden={hideReveal} /> : null}
      {opens && open ? (
        <div className="guide-row-body" id={bodyId}>
          {rulesInside ? <Automations automations={row.automations} /> : null}
          {row.children?.length ? <div className="guide-row-children"><Rows rows={row.children} onAction={onAction} /></div> : null}
          {drawFields(true)}
          {row.steps?.length ? <Steps steps={row.steps} onAction={onAction} values={values} fields={row.fields ?? []} /> : null}
          {drawFields(false)}
          {withFields.length ? <div className="guide-row-actions">{withFields.map(action => <ActionButton key={action.label} action={action} onAction={onAction} values={sentValues(row.fields, values)} onDone={done(action)} />)}</div> : null}
        </div>
      ) : null}
    </li>
  );
}

// A section's rows, drawn as they come within reach (rows-in-reach), so a section of hundreds of rows stays light.
function Rows({ rows, onAction }: { rows: GuideRow[]; onAction: GuideActionHandler }) {
  const reach = useRowsInReach(rows.length);
  return (
    <>
      <ul className="guide-rows">{rows.slice(0, reach.count).map(row => <Row key={row.id} row={row} onAction={onAction} />)}</ul>
      {reach.marker ? <div ref={reach.marker} className="guide-rows-reach" aria-hidden="true" /> : null}
    </>
  );
}

// A catalog: the shared record views give search, Filter, Sort, Table, Gallery and Board over the same rows; the list view is
// the section's own rows, drawn here through a portal into the view's host so each row keeps its state while the
// person searches. Picking a row in the table goes back to the list with that row open.
const LIST_VIEW = 'list';
function Catalog({ catalog, rows, onAction }: { catalog: GuideCatalog; rows: GuideRow[]; onAction: GuideActionHandler }) {
  const { recordFilter, configurations } = React.useContext(GuideOptionsContext);
  const savedConfigurations = useRecordConfigurations(configurations, catalog.configuration?.target, catalog.configuration?.open_path, catalog.fields);
  const [view, setView] = React.useState(catalog.view ?? LIST_VIEW);
  const [host, setHost] = React.useState<{ node: HTMLElement; ids: string[] } | null>(null);
  const [asked, setAsked] = React.useState<{ id: string; count: number } | null>(null);
  // On a card that shows one thing alone (the held card) the list is compact: just the rows, with no search, view
  // switcher, sort, filter, columns or pick boxes (the card's own thing is what the person acts on).
  const catalogNode = React.useRef<HTMLDivElement | null>(null);
  const [mode, setMode] = React.useState<'probing' | 'compact' | 'full'>('probing');
  React.useLayoutEffect(() => { setMode(catalogNode.current?.closest('.queue-card[data-alone]') ? 'compact' : 'full'); }, []);
  const compact = mode === 'compact';
  // One selection for every view: the list's own pick boxes and the table's both change it, and the record views'
  // selection bar runs a catalog's `selection` actions over it, each sending the picked rows' `pick` under its name.
  const [selected, setSelected] = React.useState<string[]>([]);
  const fields = React.useMemo<FieldDescriptor[]>(() => catalog.fields.map(({ leading, fact_from, ...field }) => ({
    ...field,
    read: (row: GuideRow) => row.facts?.[field.id] ?? '',
    // A readable name can change while the identity a saved filter uses stays
    // the same. The guide declares the source fact; RecordViews owns filtering.
    ...(fact_from ? { factValue: (row: GuideRow) => row.facts?.[fact_from] ?? '' } : {}),
    ...(leading === 'logo' ? { render: (row: GuideRow) => <span className="guide-catalog-named"><Logo src={row.logo ?? ''} name={row.title} className="guide-catalog-logo" /><span>{String(row.facts?.[field.id] ?? row.title)}</span></span> } : {}),
  })), [catalog.fields]);
  const openRow = React.useCallback((id: string) => { setView(LIST_VIEW); setAsked(current => ({ id, count: (current?.count ?? 0) + 1 })); }, []);
  const rowActions = React.useMemo(() => catalogActions(rows, onAction, openRow), [rows, onAction, openRow]);
  const mountList = React.useCallback<NonNullable<NonNullable<RecordViewsOptions['views']>[number]['mount']>>((node, { records }) => {
    const ids = (records as GuideRow[]).map(row => row.id);
    setHost(current => (current?.node === node && current.ids.join('\n') === ids.join('\n') ? current : { node, ids }));
    return () => setHost(current => (current?.node === node ? null : current));
  }, []);
  const views = React.useMemo(() => [
    { id: LIST_VIEW, label: 'List', icon: 'LayoutList', mount: mountList },
    { id: 'table', label: 'Table', icon: 'Table' },
    { id: 'gallery', label: 'Gallery', icon: 'LayoutGrid' },
    { id: 'board', label: 'Board', icon: 'Columns3' },
  ], [mountList]);
  const byId = React.useMemo(() => new Map(rows.map(row => [row.id, row])), [rows]);
  const bulkActions = React.useMemo(() => (catalog.selection ?? []).map(action => ({
    id: `guide-selection:${action.label}`,
    label: action.label,
    icon: action.icon ?? 'Check',
    confirm: action.send?.confirm,
    run: (ids: string[]) => {
      const send = action.send!;
      const picks = ids.map(id => byId.get(id)?.pick).filter((pick): pick is string => Boolean(pick));
      setSelected([]);
      void Promise.resolve(onAction(adaptAction(action, { send: { path: send.path, body: { ...send.body, [send.selection!]: picks } } }), {})).catch(() => {});
    },
  })), [catalog.selection, byId, onAction]);
  const picking = !compact && Boolean(catalog.selection?.length);
  const pickedOf = (row: GuideRow) => (picking ? { on: selected.includes(row.id), set: (on: boolean) => setSelected(now => (on ? [...now, row.id] : now.filter(id => id !== row.id))) } : undefined);
  const compactNode = React.useRef<HTMLDivElement | null>(null);
  React.useLayoutEffect(() => {
    if (!compact || !compactNode.current) return;
    const node = compactNode.current;
    const ids = rows.map(row => row.id);
    setHost(current => (current?.node === node && current.ids.join('\n') === ids.join('\n') ? current : { node, ids }));
  }, [compact, rows]);
  const shown = host ? host.ids.map(id => byId.get(id)).filter((row): row is GuideRow => Boolean(row)) : [];
  // Only the rows in reach are drawn (rows-in-reach): a catalog of hundreds of rows drew every one and froze the page.
  const reach = useRowsInReach(shown.length, asked ? shown.findIndex(row => row.id === asked.id) : -1);
  // What runs behind a field shows beside its column name in the table; the list has no column names, so the list
  // lists them above its rows, each with its hover card.
  const behindFields = React.useMemo(() => catalog.fields.flatMap(field => (field.automations ?? []) as GuideAutomation[]).filter((item, at, all) => all.findIndex(other => other.id === item.id) === at), [catalog.fields]);
  return (
    <div className="guide-catalog" ref={catalogNode} data-compact={compact ? 'true' : undefined}>
      {mode === 'full' && view === LIST_VIEW ? <Automations automations={behindFields} /> : null}
      {compact ? <div ref={compactNode} className="guide-catalog-compact" /> : null}
      {mode === 'full' ? <RecordViews
        label={catalog.label}
        fields={fields}
        records={rows}
        identify={(row: GuideRow) => row.id}
        shareRecord={(row: GuideRow) => row.share_record ?? null}
        aboutRecord={(row: GuideRow) => row.record ? { kind: 'record', id: row.record, record: row.record, title: row.title,
          // A row may be inspectable without being ours to share. Its source
          // explicitly supplies the sharing reference; otherwise carry a link.
          share: row.share_record ? { kind: 'record', record: row.share_record, title: row.title }
            : row.record_open ? { kind: 'link', url: row.record_open, title: row.title } : { kind: 'text', text: row.title },
        } : null}
        views={views}
        view={view}
        onViewChange={setView}
        onOpen={openRow}
        rowActions={rowActions}
        bulkActions={bulkActions}
        selected={selected}
        onSelectionChange={setSelected}
        preferenceKey={`guide-catalog:${catalog.label}`}
        {...savedConfigurations}
        ruleOperators={recordFilter?.ruleOperators}
        loadFilterRecords={recordFilter?.loadFilterRecords}
        emptyMessage={catalog.empty ?? 'Nothing matches.'}
      /> : null}
      {host ? createPortal(
        shown.length ? <>{picking ? <label className="guide-pick-all"><Checkbox checked={shown.every(row => selected.includes(row.id))} onCheckedChange={on => setSelected(on === true ? [...new Set([...selected, ...shown.map(row => row.id)])] : selected.filter(id => !shown.some(row => row.id === id)))} />{`Pick all ${shown.length} shown`}</label> : null}<ul className="guide-rows">{shown.slice(0, reach.count).map(row => <Row key={row.id} row={row} onAction={onAction} openAsked={asked?.id === row.id ? asked.count : 0} picked={pickedOf(row)} />)}</ul>{reach.marker ? <div ref={reach.marker} className="guide-rows-reach" aria-hidden="true" /> : null}</> : <p className="guide-note" role="status">{catalog.empty ?? 'Nothing matches.'}</p>,
        host.node,
      ) : null}
    </div>
  );
}

// What a catalog row's hover card and menu offer: each action its row (or its one account) has, by label. An action that
// needs nothing more (open a sign-in page, check an account) runs from the card; one that asks first (a confirmation,
// boxes to fill, a new name) opens the row in the list with its steps and boxes, where the same button asks in place.
function catalogActions(rows: GuideRow[], onAction: GuideActionHandler, openRow: (id: string) => void) {
  const offered = (row: GuideRow) => [...(row.actions ?? []), ...(row.items?.length === 1 ? row.items[0].actions ?? [] : [])].filter(action => !action.switch && !action.copy);
  const labels = [...new Set(rows.flatMap(row => offered(row).map(action => action.label)))];
  return labels.map(label => {
    const actionOf = (row: GuideRow) => offered(row).find(action => action.label === label);
    const first = rows.map(actionOf).find(Boolean)!;
    return {
      id: `guide-action:${label}`,
      label,
      icon: first.icon ?? (first.href ? 'ExternalLink' : 'ArrowRight'),
      tone: first.tone === 'danger' || first.tone === 'plain-danger' ? 'destructive' : undefined,
      lead: true,
      appliesTo: (row: GuideRow) => Boolean(actionOf(row)),
      run: (ids: string[]) => {
        for (const id of ids) {
          const row = rows.find(item => item.id === id);
          const action = row && actionOf(row);
          if (!row || !action) continue;
          if (action.send?.confirm || action.send?.with_fields || action.tool?.with_fields || action.send?.ask) openRow(id);
          else void onAction(action, {});
        }
      },
    };
  });
}

/** A banner with the section's explanation: its button at the banner's end, the card opening under the banner. */
function SectionBanner({ banner, explain }: { banner: GuideBanner; explain?: GuideExplain }) {
  const state = useExplain();
  return (
    <div className="banner">
      <Banner banner={banner} end={explain ? <span className="explain-toggle-host" ref={state.toggleRef}><ExplainToggle explain={explain} open={state.open} onToggle={state.toggle} controls={state.id} /></span> : undefined} />
      {explain && state.open ? <ExplainPanel explain={explain} id={state.id} onClose={state.close} /> : null}
    </div>
  );
}

function Section({ section, onAction }: { section: GuideSection; onAction: GuideActionHandler }) {
  const { post, parts } = React.useContext(GuideOptionsContext);
  const Lent = section.part ? parts?.[section.part] : undefined;
  const { reveal, keepFor, hide: hideReveal } = useReveals(section.actions);
  const choose = section.choose;
  const [chosen, setChosen] = React.useState<string | null>(choose?.chosen ?? null);
  // A pick that is no longer among the open times is let go.
  const open = choose ? choose.days.some(day => day.options.some(option => option.value === chosen)) : false;
  const picked = open ? chosen : null;
  const valuesFor = (action: GuideAction) => (choose && (action.send?.with_fields || action.tool?.with_fields) && picked ? { [choose.name]: picked } : {});
  const waits = (action: GuideAction) => Boolean(choose && (action.send?.with_fields || action.tool?.with_fields) && !picked);
  return (
    <section className="guide-section" data-guide-section={section.id}>
      {section.heading || section.prompt ? (
        <div className="guide-section-top">
          {section.heading ? <h2 className="guide-section-heading">{section.heading}</h2> : null}
          {section.prompt ? <CopyButton text={section.prompt.text} label={section.prompt.label} size="default" /> : null}
        </div>
      ) : null}
      {section.body ? <p className="guide-section-body">{section.body}</p> : null}
      {Lent ? <div className="guide-part"><Lent /></div> : null}
      {section.fan ? <LogoFan fan={section.fan} /> : null}
      {section.profile ? <ProfileCard profile={section.profile} onAction={onAction} /> : null}
      {section.banner ? <SectionBanner banner={section.banner} explain={section.explain} /> : section.explain ? <Explain explain={section.explain} /> : null}
      {section.table ? <RankTable table={section.table} onAction={onAction} /> : null}
      {section.courses?.length ? <CourseCards courses={section.courses} onAction={onAction} /> : null}
      {section.people?.length ? <PersonCards people={section.people} action={action => <ActionButton action={action} onAction={onAction} />} /> : null}
      {section.chain?.links.length ? <ChainList chain={section.chain} /> : null}
      {section.offer ? <OfferCard offer={section.offer} /> : null}
      {section.tabs?.length ? <Tabs tabs={section.tabs} onAction={onAction} requireChoice={section.tabs_require_choice} /> : null}
      {section.steps?.length ? <Steps steps={section.steps} onAction={onAction} /> : null}
      {section.cards?.length ? <Cards cards={section.cards} onAction={onAction} /> : null}
      {section.stats?.length ? <StatTiles tiles={section.stats} /> : null}
      {section.split?.segments.length ? <UsageMeter className="guide-split" label={section.split.label} total={section.split.total} segments={section.split.segments} /> : null}
      {section.trends?.length ? <TrendLines lines={section.trends} /> : null}
      {section.share && post ? <ShareSheet card={section.share.card} text={section.share.text} places={section.share.destinations} words={section.share.words} create={body => post(section.share!.send.path, body)} /> : null}
      {section.link_share ? <LinkShareSheet {...section.link_share} /> : null}
      {section.thread ? <Thread thread={section.thread} onAction={(action, values) => onAction(action, values)} /> : null}
      {section.ranks?.length ? <RankList rows={section.ranks} /> : null}
      {section.catalog && Array.isArray(section.rows) ? <Catalog catalog={section.catalog} rows={section.rows} onAction={onAction} /> : null}
      {section.rows?.length && !section.catalog ? <Rows rows={section.rows} onAction={onAction} /> : null}
      {choose ? <TimeSlotPicker days={choose.days} value={picked} onChange={setChosen} label={choose.label} /> : null}
      {section.empty ? <div className="guide-empty"><EmptyState icon={section.empty.icon ? <NamedIcon name={section.empty.icon} aria-hidden /> : undefined} title={section.empty.title} description={section.empty.body} /></div> : null}
      {section.note ? <p className="guide-note">{section.note}</p> : null}
      {reveal ? <RevealBox shown={reveal} onHidden={hideReveal} /> : null}
      {section.actions?.length ? <div className="guide-section-actions">{section.actions.map(action => <ActionButton key={action.label} action={action} onAction={onAction} values={valuesFor(action)} disabled={waits(action)} onDone={keepFor(action)} />)}</div> : null}
      {section.footnote ? <p className="guide-note">{section.footnote}</p> : null}
    </section>
  );
}

export function Guide({ description, onAction, options = {} }: { description: GuideDescription; onAction: GuideActionHandler; options?: GuideOptions }) {
  const [ownReveals] = React.useState(guideReveals);
  const reveals = options.reveals ?? ownReveals;
  const aside = description.aside ?? [];
  const sections = description.sections.map((section, index) => <Section key={`${index}:${section.heading ?? ''}`} section={section} onAction={onAction} />);
  return (
    <GuideOptionsContext.Provider value={options}>
    <RevealsContext.Provider value={reveals}>
    <div className="guide" data-aside={aside.length ? '' : undefined}>
      {description.hide_header ? null : (
        <header className="guide-header">
          <h1 className="guide-title">{description.title}</h1>
          {description.lead ? <p className="guide-lead">{description.lead}</p> : null}
          {description.progress ? <Progress progress={description.progress} /> : null}
          {description.badge ? <Status status={description.badge} className="guide-header-badge" /> : null}
        </header>
      )}
      {aside.length ? (
        <div className="guide-columns">
          <div className="guide-main">{sections}</div>
          <aside className="guide-aside" aria-label={description.title}>
            {aside.map((section, index) => <Section key={`${index}:${section.heading ?? ''}`} section={section} onAction={onAction} />)}
          </aside>
        </div>
      ) : sections}
      {description.narrowed && options.widen ? <div className="guide-widen"><Button type="button" size="default" variant="outline" onClick={options.widen}>{description.narrowed.label}</Button></div> : null}
    </div>
    </RevealsContext.Provider>
    </GuideOptionsContext.Provider>
  );
}

/** A drawn guide: `update` draws a newer description in place (open rows, the chosen tab and typed boxes stay as they
 *  were, since rows are keyed by id), `unmount` removes it. */
export type MountedGuide = { update: (description: GuideDescription) => void; unmount: () => void };

/** Draw a guide into `node`. */
export function mountGuide(node: HTMLElement, description: GuideDescription, onAction: GuideActionHandler, options: GuideOptions = {}): MountedGuide {
  let current = description;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const read = () => current;
  function Host() {
    return <Guide description={React.useSyncExternalStore(subscribe, read, read)} onAction={onAction} options={options} />;
  }
  const unmount = mountReactSurface(node, <Host />);
  return { update(next) { current = next; for (const listener of listeners) listener(); }, unmount };
}
