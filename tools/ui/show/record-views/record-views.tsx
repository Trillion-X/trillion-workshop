// packages/ui/show/record-views/record-views.tsx
//
// Purpose
//   A CRM over any set of records, shaped like Twenty CRM's record views: one
//   view bar owning the view choice, a rule filter (rules nested in All / Any
//   groups, decided by the formula engine), a
//   field manager that shows, hides and reorders columns, and three views over
//   the same records (table, board, gallery).
//
// Provenance
//   The anatomy and every visual rule come from Twenty CRM. Their components are
//   bound to Jotai component-state and their object-metadata layer, so they
//   cannot be lifted as-is; what carries across is the structure, the class
//   names, the wording, and their stylesheet.
//     - `../twenty/theme-light.css` / `theme-dark.css` are Twenty's generated
//       token files byte-for-byte.
//     - `../twenty/record-table.css` transcribes the rules their Linaria blocks
//       declare.
//     - Filtering is the shared rule filter (`../rule-filter`), whose
//       comparisons are formula-engine DATA; this surface never compares.
//     - The field manager follows
//       RecordTableFieldsDropdownVisibleFieldsContent: a draggable list with a
//       grip and a hide button per row, the identifying field pinned and
//       undraggable, and hidden fields behind their own section.
//   Twenty is AGPL-3.0. Nothing marked `@license Enterprise` was read or used.
//
// Non-negotiable invariants
//   - No app, product, route or field name appears in this file.
//   - Appearance lives in the stylesheet, never as inline style objects here,
//     except the two tone colours a descriptor supplies as data.
//   - Every open set is DATA: fields, views, tones, comparisons, groupings.
//     There is no closed union of statuses, field kinds or views, and nothing
//     here branches on which one it is holding.
//   - The view bar is the only place a view is chosen. A caller that renders a
//     second switcher beside it has two sources of truth for one piece of state.

import type {RecordFrom, RecordNew, RecordSource} from '../record-picker'
import {recordText} from 'trillion-workshop/tools/ui/show/record-picker/record-value.ts'
import {relativeDate} from '../relative-time/relative-time'
import React, {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react'
import {createRoot} from 'react-dom/client'
import {claimNode, releaseNode} from '../one-owner-per-node'
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from '../coss/ui/table'
import {TableColumnResizeHandle} from '../table'
import {Button} from '../coss/ui/button'
import {ExpandableTabs, type ExpandableTabItem} from '../expandable-tabs/ExpandableTabs'
import {NamedIcon} from '../icon'
import {Spinner} from '../spinner'
import {Badge} from '../coss/ui/badge'
import {Checkbox} from '../coss/ui/checkbox'
import {Input} from '../coss/ui/input'
import {Popover, PopoverPopup, PopoverTrigger} from '../coss/ui/popover'
import {SearchField} from '../search-field/SearchField'
import {errorWords} from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts'
import {ScreenState} from '../screen-state/ScreenState'
import {Badge as CountChip} from '../badge/Badge'
import {ActionMenu, type ActionMenuItem, type MenuThing} from '../action-menu'
import {RowActionMenu} from './row-action-menu'
export {RowActionMenu} from './row-action-menu'
import {useArrivals} from './arrivals'
import {PreviewCard} from '@base-ui/react/preview-card'
import {DisclosureHeading} from '../disclosure-heading/DisclosureHeading'
import {HoverPreview, type PreviewItem} from '../hover-preview/HoverPreview'
import {CARD_CONTROLS, cardShown} from '../hover-preview/card-shown'
import {RecordKindMark} from '../record-kind'
import {ProgressBar} from '../progress-bar'
import {LAYER_ORDER} from '../layer-order/layer-order'
import {AutomationMarks, type BackingAutomation} from '../automation-preview/AutomationPreview'
import {toneForValue} from './record-view-tokens'
import {CustomFieldForm, type CustomFieldKind} from './custom-field-form'
import type {HoverForm} from './hover-form'
import type {SavedViewTime} from './saved-view-time-editor'
// The time editor (and its date picker) arrives when a saved view's time is first edited, so a list opens without it.
const SavedViewTimeEditor = lazyPart(() => import('./saved-view-time-editor'), module => module.SavedViewTimeEditor)
// Calendar code is needed only while a date cell is being edited.
const InlineDatePicker = lazyPart(() => import('../date-picker/DatePicker'), module => module.DatePicker)
// The answer-in-place popover is fetched the first time a list holds a value that asks for an answer; until it
// arrives the value is drawn as it is.
const HoverFormCell = lazyPart(() => import('./hover-form'), module => module.HoverFormCell)
// A list with no linked fields never needs the record chooser.
const LinkCell = lazyPart(() => import('../record-picker/LinkCell'), module => module.LinkCell)
const RecordPicker = lazyPart(() => import('../record-picker/RecordPicker'), module => module.RecordPicker)
import {Card} from '../coss/ui/card'
import type {RuleFacet, RuleFieldView} from '../rule-filter/RuleFilter'
import { later, lazyPart } from '../load-later/later'
import {setSelectedRecordDragData} from '../selection/selected-record-drag'
// The filter's menu and chips are fetched the first time a list draws them, never with the screen.
const RuleFilterMenu = lazyPart(() => import('../rule-filter/RuleFilter'), module => module.RuleFilterMenu)
const RuleFilterChips = later(() => import('../rule-filter/RuleFilter'), module => module.RuleFilterChips)
// A media column's screen (the one file preview, or the item's small picture, text or icon), fetched the first time a
// list draws a media cell: its other fields and the hover cards never wait on it.
const PreviewScreen = later(() => import('../hover-preview/PreviewScreen'), module => module.PreviewScreen)
import {appendAt, countRules, emptyGroup, holdsValue, isGroup, newRule, operatorsFor, replaceAt, toggleValue, type RuleGroup, type RuleNode, type RuleOperatorData} from '../rule-filter/rule-tree'
import {ancestry, bucketsFor, buildSections, flattenSections, recordsIn, type GroupBucket, type GroupLevel, type SectionBlock, type SectionNode} from './group-sections'
import {orderIds} from './field-order'
import {bucketFor, levelIndex, type TimelineLevels} from './timeline-buckets'
import defaultDetailLevels from './detail-levels.json'
import boardWords from './board-words.json'
import {contentTopOf, offsetsOf, scrollerOf, useMeasuredHeight, useScrollWindow, visibleRange} from './windowing'
import {useScrollFade, watchScrollFade, type ScrollFadeEdge} from '../scrollable-surface/scroll-fade'
// The sheet's grid is fetched the first time a list is drawn as a sheet.
const SheetView = lazyPart(() => import('./sheet-view'), module => module.SheetView)
const NotesDocument = lazyPart(() => import('../notes-document/NotesDocument'), module => module.NotesDocument)
import {allOf, effectiveRule, type NodeRuleStore} from '../rule-filter/focus-chain'
import {nodeRulePath, nodeRuleStore} from '../rule-filter/focus-records'
import {viewsOfferedToEveryList} from './every-list-views'
import {DESIGNED_VIEWS_PREFERENCE, designedRecordView, keptRows, type DesignedViewRow} from './view-designs'
import type {GroupGraph} from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts'
import type {AddressRef} from 'trillion-workshop/tools/turn-frames-into-slides/read-data/visual-layer-types.ts'
import {useRecordViewPreference, writeRecordViewPreference} from './record-view-preferences'
import {controlShown, useShowChange} from '../show-rules/show-of'
import {calendarBucket, calendarBucketSpan, projectSavedView, type SavedTimeBound} from 'trillion-workshop/tools/keep-lists-of-rows/read-data/saved-view-engine.mjs'
import {applyConfigurationSettings, captureConfigurationSettings, configurationAspects, selectedConfigurationAspects} from 'trillion-workshop/tools/keep-lists-of-rows/read-data/configuration-values.mjs'

type ViewPreferences = {columnWidths?: Record<string, number>; compact?: boolean; order?: string[]; hidden?: string[]; align?: Record<string, ColumnAlign>; frozen?: number; view?: string; collapsedColumns?: string[]; groupLevels?: GroupLevel[]; detail?: string; displaySettings?: Record<string, Record<string, unknown>>}

/** One step of a pinch on a gallery or board: how many shown fields a card says under its name (null: all, 0: the
 *  name alone), a gallery card's width, and whether the words stay under a picture. */
export type DetailLevel = {id: string; label: string; fields: number | null; tile_px: number; words_under_picture?: boolean}
/** The steps a pinch moves through, most detail first (detail-levels.json). */
export type DetailLevels = {default_level: string; levels: DetailLevel[]}
const DEFAULT_DETAIL_LEVELS = defaultDetailLevels as DetailLevels
const BOARD_WORDS = boardWords as {fold: string; unfold: string; folded_title: string; item_one: string; item_many: string}
const defaultRecordId = (record: any) => String(record?.id ?? '')

export type FieldDescriptor = {
  id: string
  label: string
  /** A date field read as a person plans by it ("Tomorrow", "Tue 3:00 PM", from the shared relative-time owner) instead of a numeric date. */
  relativeDates?: boolean
  /** Owner-supplied expression template used by its derived read projection. */
  defaultExpression?: unknown
  /** Lucide icon name for this field wherever it appears as a menu row. */
  icon?: string
  read?: (record: any) => unknown
  /** Draw a field's value while `read` continues to supply its searchable,
   * sortable and filterable text. */
  render?: (record: any) => React.ReactNode
  /** A thumbnail field's picture as an address a gallery can load (null when the record has none), for a field whose
   *  `render` draws the picture itself and `read` holds no address. */
  pictureUrl?: (record: any) => string | null
  /** An image file represents the record before a still standing in for another kind of file. */
  pictureSource?: (record: any) => 'image' | 'poster' | null
  /** Draw a grouped section heading from its stable group value and records. */
  renderGroup?: (value: string, records: any[]) => React.ReactNode
  /** The field holds a document (written and read as markdown): the first such field is each record's notes, the
   *  words a designed view draws as a record's body. */
  document?: boolean
  /** How the value is drawn. `tag`/`chip` render soft chips, `thumbnail` an
   *  image, anything else plain text. Open set: an unknown kind draws as text. */
  kind?: string
  /** The kind of fact this field holds for filtering (formula-engine
   *  rule-operators.json `applies_to`: text, choice, tags, number, duration,
   *  bytes, date, or any kind a new operator row names). Picks the comparisons
   *  its rules offer. A filterable field needs one. */
  ruleKind?: string
  /** The unit a number is measured in, shown beside it ("LUFS", "fps"). */
  unit?: string
  /** The value a rule compares, when the drawn text is not it (seconds for a
   *  length drawn as 1:30, milliseconds for a date drawn as "Sep 26"). */
  factValue?: (record: any) => unknown
  /** A link cell the person can change: the list its rows are found in, where they are searched, and the rows linked now.
   *  The cell is saved as the whole new set of row ids, comma separated, the same save a typed cell uses. */
  links?: {from: RecordFrom; source: RecordSource; current: (record: any) => {id: string; title: string}[]}
  /** A name chosen from real rows; keeps its title text. Identity links use links above. */
  records?: {from: RecordFrom; made?: RecordNew; source: RecordSource}
  width?: number
  sortable?: boolean
  /** The value a sort compares, when the drawn text does not order correctly
   *  (a localised date, for example). Numbers compare numerically. */
  sortValue?: (record: any) => unknown
  filterable?: boolean
  groupable?: boolean
  /** Per-value label and tone overrides. A value with no row here still draws,
   *  humanised, with a tone derived from the value itself. A value naming a
   *  `parent` (a project inside a project) nests under it when grouped. A
   *  value marked `working` (someone is doing it now) draws the one loading
   *  mark beside its label. A value marked `settled` (done, closed) counts as
   *  finished when the Map works out how much of a branch is done. */
  values?: Record<string, {label?: string; tone?: string; icon?: string; parent?: string; working?: boolean; settled?: boolean}>
  /** How this field can group, when not a tree's or a date's usual choices. */
  groupBuckets?: GroupBucket[]
  /** Draw this field's value over a gallery card's picture, the way a photo
   *  library marks the days left on each photo. Empty values draw nothing. A
   *  function decides per record, so a field can group and filter on every
   *  value ("Not used yet") while marking only the records worth marking. */
  cardOverlay?: boolean | ((record: any) => boolean)
  /** Starts out of the way, still there in the fields list to be brought back.
   *  A field used for grouping or section headings is usually this: the heading
   *  already says what a column of it would repeat on every row. */
  hiddenByDefault?: boolean
  /** What runs by itself behind this field (a rule, a schedule, a workflow), as the screen's DATA names it: a mark
   *  beside the column name opens its hover card, and a press opens it to edit (../automation-preview). */
  automations?: BackingAutomation[]
  /** The field chooses its own values, for a set a flat list cannot hold: a
   *  tree of projects, a person. Mounted into the rule's value popup in place
   *  of the checklist; it may return its own teardown. */
  pickValues?: RuleFieldView['pickValues']
  /** Count for a tag when its total spans more rows than the current page. */
  countValue?: (records: any[], value: string) => number
  /** The caller owns edits to this field's record values. */
  editable?: boolean
  /** Show this field in the record's hover preview (gallery card, table row,
   *  board card), in the order fields are declared. Empty values are left out.
   *  `heading` places it on the preview's title line. A `kind: 'media'` field
   *  is the preview's content screen (`../hover-preview`). */
  preview?: boolean | 'heading'
  /** Read the value when the preview opens, for a fact too costly to hold on
   *  every record (a transcript passage). Resolves to the value to draw. */
  load?: (record: any) => Promise<unknown>
  /** When this record's value asks the person for something, the form that
   *  answers it: hovering (or pressing) the value opens it in a popover beside
   *  the value. Return nothing for a record with nothing to ask. */
  hoverForm?: (record: any) => HoverForm | null | undefined
  /** Where the value sits in its column (table, sheet). A person's own choice
   *  from the column menu wins; without either, a column whose values are
   *  numbers sits right and every other column left. */
  align?: ColumnAlign
  /** A small picture drawn before the value in its column and before a card's
   *  title: an icon name (with its accessible label), or anything the caller
   *  draws itself. Return nothing for a record with no mark. */
  mark?: (record: any) => FieldMark | null | undefined
  /** The shared name a wider level's focus uses for this field ("pursuit",
   *  "space"): a rule set above this list on that name reads this field, so one
   *  focus narrows every list that holds the fact, whatever each calls it. */
  scope?: string
  /** The part this field plays in a designed view (./view-designs): "body", "author", "when", "status", "detail",
   *  "parent", or any slot a design reads. A design fills its slots from the fields declaring them. */
  role?: string
  /** The records this record is linked to, for the Canvas (a map of the list): the value is one id or a list of ids of
   *  records in the same list. `from` draws each line from the named record into this one (this record came from
   *  it, as work comes from a message); `to` draws each line out from this record to the named ones. */
  links?: {direction: 'from' | 'to'}
}

export type ColumnAlign = 'left' | 'center' | 'right'

/** What a field's `mark` draws: a NamedIcon by name, or the caller's own node. */
export type FieldMark = {icon: string; label?: string} | React.ReactElement

/** How a saved view is drawn: `as` is the id of any view the list offers (a chart, a board), `settings` that view's own
 *  choices as plain JSON, handed back to it in RecordViewContext.settings. Nothing here names a view. */
export type ConfigurationContext = {now?: number; resolveTimeBound?: (point: SavedTimeBound, now: number) => Promise<number | null>}
export type SavedViewSurface = {columnWidths?: Record<string, number>; compact?: boolean; align?: Record<string, ColumnAlign>; frozen?: number; detail?: string | null; timeline?: string | null}
export type SavedViewDisplay = {as: string; settings?: Record<string, unknown>; surface?: SavedViewSurface}

/** A named configuration, owned and stored by the caller. `rules` is the
 *  formula-engine rule tree the filter builds. Missing `aspects` is the legacy
 *  complete configuration; a partial one changes only its named aspects. */
export type SavedRecordView = {
  id: string; label: string; search: string; rules: RuleGroup
  sort?: {field: string; direction: 'asc' | 'desc'}[]; groups?: GroupLevel[]
  columns?: {order?: string[]; hidden?: string[]}; time?: SavedViewTime; time_zone?: string
  display?: SavedViewDisplay | null; aspects?: string[]; owner?: {id: string; name: string}
  record_ref?: string; revision?: number; readOnly?: boolean; canRemove?: boolean; canShare?: boolean
}

/** A view the caller draws itself (a calendar, a map) from the same records
 *  the table shows after search and filters. It receives its host and the
 *  visible records on every change and may return a teardown (`mount`), or,
 *  for a view drawn with React, returns what to draw (`render`), which draws
 *  inside this list's own tree: no second React root, and the view keeps its
 *  state while the records change. */
export type RecordView = {
  id: string
  label: string
  /** NamedIcon name drawn in the view switcher; the label shows when chosen or pointed at. */
  icon?: string
  /** Which edges fade while records run past them. Top and bottom follow the
   *  scroller that holds the surface, left and right the view's own sideways
   *  scroll. A built-in view left without this uses its default below. */
  fadeEdges?: readonly ScrollFadeEdge[]
  mount?: (host: HTMLElement, context: {records: any[]; open?: (id: string) => void}) => void | (() => void)
  render?: (context: RecordViewContext) => React.ReactNode
  /** A caller that owns its empty result must receive zero rows too. */
  ownsEmpty?: boolean
  /** The DATA row this view was made from, when it is a designed view (./view-designs): the Saved views menu offers to
   *  keep it for every list. */
  designed?: DesignedViewRow
  /** Offered only to a list whose fields (and nesting) this holds for (a timeline only where some field is a date,
   *  a tree only where records nest). Without it the view is offered to every list. */
  offeredFor?: (fields: FieldDescriptor[], nesting?: RecordNesting) => boolean
}

/** What a view drawn with React receives: the records after search and filters,
 *  how to open one, and the list's own fields, name and identity, so a view
 *  offered to every list (`registerEveryListView`) can draw any list. */
export type RecordViewContext = {
  /** Existing shared controls for a caller-drawn view; hide the outer bar when placing these. */
  toolbar: {search: React.ReactNode; views: React.ReactNode; actions: React.ReactNode; displayActions?: React.ReactNode; primaryActions?: React.ReactNode}
  /** The current search words, for additional caller-owned collections in the same view. */
  searchText: string
  records: any[]
  open?: (id: string) => void
  /** The current field order after the person's hidden-field choices; `fields` remains the full schema for filtering and grouping. */
  visibleFields: FieldDescriptor[]
  /** The shared text form of a field value, including DATA labels. */
  formatFieldValue: (field: FieldDescriptor, record: any) => string
  fields: FieldDescriptor[]
  label: string
  identify: (record: any) => string
  nesting?: RecordNesting
  /** Keeps changes a view makes (a record added, a value set, a record moved under another), when the list takes them. */
  write?: RecordWrite
  /** Reads the records (and their nesting) again from where they are kept, so a view checks a change it made against
   *  the list itself rather than what it last drew. */
  reread?: () => Promise<{records: any[]; nesting?: RecordNesting}>
  /** The grouping the person chose, outermost first: a designed view draws its sections from it. */
  groupLevels?: GroupLevel[]
  /** Sections computed by this owner with the current grouping and time zone. */
  sections?: readonly SectionNode[]
  /** The current sort keys in display order, including secondary keys. */
  sort?: {field: string; direction: 'asc' | 'desc'}[]
  /** The list's row actions: a designed view draws the `lead` ones as each record's own buttons. */
  rowActions?: BulkAction[]
  /** What a record is, as its ⋯ menu names it (RecordViewsOptions.aboutRecord). */
  aboutRecord?: (record: any) => MenuThing | null
  /** How a new record is written into this list, when the list takes words (a message, a reply to one). */
  compose?: RecordCompose
  /** What a list adds to a record as one design draws it (a vote, a menu, a shared thing), by the design's id. */
  designExtras?: (design: string, record: any) => Record<string, unknown> | undefined
  /** Runs a press a design reports that is not its own (a menu row or button the list's extras added). */
  designAction?: (action: {id?: string; label: string}, values: Record<string, string>) => unknown
  /** How much each record says, the step a pinch, Ctrl/Cmd with + or −, or Zoom in and out chose (detail-levels.json):
   *  the same steps every view of the list moves through. */
  detail?: DetailLevel
  /** What this list is (RecordViewsOptions.identity): what a view keeps for this list alone, such as where a board's
   *  cards sit and what was drawn around them, is kept under it. */
  identity?: string
  /** The list's own lines between records beyond its linking fields (RecordViewsOptions.links). */
  links?: (records: any[]) => RecordLink[]
  /** The field holding each record's state (RecordViewsOptions.statusField). */
  statusField?: string
  /** What the list can add by kind (RecordViewsOptions.adds). */
  adds?: RecordAdds
  /** The choices this view keeps with the saved configuration that is open (SavedViewDisplay.settings), when that configuration is
   *  drawn by this view. A view reads them in place of its own per-list preference and falls back to the preference
   *  when this is left out. */
  settings?: unknown
  /** Holds current choices for a later complete or partial save. With an editable
   *  saved configuration that includes display, also keeps the choices on that
   *  record. Without one, the list's own preference keeps them between visits. */
  saveSettings?: (next: Record<string, unknown>) => void
  /** While a filter rule is in force and the filter is still arriving or could not load, the view is handed no rows:
   *  `applying` or `failed` says so, so a view that owns its empty result never says the list is empty then. */
  filtering?: 'applying' | 'failed' | null
  /** True when the page only shows the list (a public share): a view draws what it is given and offers no control that
   *  would change it. */
  readOnly?: boolean
}

/** Writing into a list from a view: `send` keeps the words (under `parent` for a reply); `box`, when the list has its
 *  own box (mentions, files), draws it in place of a plain one. */
export type RecordCompose = {
  label?: string
  placeholder?: string
  send: (words: {text: string; parent?: string}) => Promise<void>
  /** The list's own box. A view that answers one record (a chat's Reply) hands it that record as `reply.parent`; the
   *  box sends under it and calls `reply.done` once the message is kept. */
  box?: (reply?: {parent: string; done: () => void}) => React.ReactNode
}

/** One change a view asks the list to keep: values set on a record (a new one when `create`), `members` the records
 *  nested under it, in order (the list's nesting), so moving a record is one change to each record it leaves or
 *  joins, or the record taken away (`remove`). */
export type RecordChange = {id: string; create?: boolean; values?: Record<string, unknown>; members?: string[]; remove?: boolean}
/** Keeps a batch of changes together; it settles once the list has kept them. */
export type RecordWrite = (changes: RecordChange[]) => Promise<void>

/** How a list's records nest, in the one group model (../group/group-graph): each group is the record it names, its
 *  ordered members the records under it, so a record may sit under several. `identityOf` names the record an
 *  address points at (default: its `id` part). */
export type RecordNesting = {
  graph: GroupGraph
  identityOf?: (ref: AddressRef) => string | null
  /** The field the nesting is kept in, when it is one: it is the records' structure, so no view draws it as a fact. */
  field?: string
}

function CallerView({mount, records, open}: {mount: NonNullable<RecordView['mount']>; records: any[]; open?: (id: string) => void}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ref.current) return
    const teardown = mount(ref.current, {records, open})
    return typeof teardown === 'function' ? teardown : undefined
  }, [mount, records, open])
  return <div ref={ref} className="record-views-caller-view"/>
}

// Caller-drawn toolbar content, mounted once per mount function.
function ToolbarSlot({mount}: {mount: NonNullable<RecordViewsOptions['toolbarStart']>}) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!ref.current) return
    const teardown = mount(ref.current)
    return typeof teardown === 'function' ? teardown : undefined
  }, [mount])
  return <span ref={ref} className="record-views-toolbar-start"/>
}

export type BulkAction = {
  id: string
  label: string
  run: (ids: string[]) => void
  /** A Lucide icon name ("archive", "trash-2") drawn before the label. DATA,
   *  so a new action names its icon without a change here. */
  icon: string
  /** `destructive` tints the row; anything else draws as a normal row. */
  tone?: string
  /** Shown as a key hint on the row, e.g. {key: 'Backspace', modifiers: ['meta']}. */
  shortcut?: ActionMenuItem['shortcut']
  /** Whether this action can run on one record. The caller decides from the
   *  record's own data (its kind, its state); omitted means every record. */
  appliesTo?: (record: any) => boolean
  /** Nested choices for one record (projects and folders, say): the row opens
   *  them as a submenu on hover, and a choice's own `items` nest again, to any
   *  depth. DATA from the caller, read only while the menu is open. */
  choices?: (record: any) => readonly ActionMenuItem[] | Promise<readonly ActionMenuItem[]>
  /** Runs the chosen nested choice; `run` still runs a row that has no choices. */
  choose?: (ids: string[], choiceId: string) => void
  /** Drawn as its own button where a record is shown with room for it (its
   *  hover preview); every other action stays in the ⋯ menu. */
  lead?: boolean
  /** Words the selection bar shows before it runs: the bar asks in place
   *  (Yes / Keep it) and runs the action only on Yes. */
  confirm?: string
}

/** The formula engine's record filter: the records the rules keep. */
export type FilterRecords = (records: any[], rules: RuleGroup, fields: {id: string; kind: string; value: (record: any) => unknown}[]) => any[]

/** A resource owner may supply a read-only current-value projection. The
 * surface fences late replies against the records, schema and projector that
 * started the request before allowing those rows into rules or views. */
export type DerivedReadProjection = {
  project: (records: readonly any[], fields: readonly FieldDescriptor[]) => Promise<{records: readonly any[]; incomplete?: true}>
  /** Current owner rows with calculated cells withheld while evaluation is pending. */
  pending?: (records: readonly any[], fields: readonly FieldDescriptor[]) => readonly any[]
}

export type RecordViewsOptions = {
  fields: FieldDescriptor[]
  records: any[]
  derivedReadProjection?: DerivedReadProjection
  identify?: (record: any) => string
  /** The owner's shareable reference for this row, when it has one. */
  shareRecord?: (record: any) => string | null
  /** What a record is, as every ⋯ menu names the thing it is about (action-menu/menu-rows.ts): its menus offer every row
   *  the page has for it. Without it, a record with a share reference is that record. */
  aboutRecord?: (record: any) => MenuThing | null
  /** How these records nest (tasks under tasks, pursuits under pursuits), for the views that draw nesting. */
  nesting?: RecordNesting
  /** Keeps what a view changes (a record added, a value set, a record moved under another). Without it views only read. */
  write?: RecordWrite
  /** How words are written into this list from a view that takes them (a chat, a feed). */
  compose?: RecordCompose
  /** What a list adds to a record as one design draws it, by the design's id (see RecordViewContext). */
  designExtras?: RecordViewContext['designExtras']
  /** Runs a press a design reports that is not its own (see RecordViewContext). */
  designAction?: RecordViewContext['designAction']
  /** Reads the records and their nesting again where they are kept (what a view checks its own changes against). */
  reread?: () => Promise<{records: any[]; nesting?: RecordNesting}>
  /** Which views this surface offers, in bar order. DATA, so a fourth is one
   *  row. The views offered to every list (sheet, map, history, a person's own
   *  designed views) follow them unless `onlyTheseViews` is set. */
  views?: RecordView[]
  /** Offer only `views`: for a list someone reads but keeps nothing in (a
   *  public page), where a sheet to edit or a history of changes has nothing
   *  to show. */
  onlyTheseViews?: boolean
  /** Show how many records there are beside the title (on unless false). A list whose view already shows its whole
   *  window (a calendar's week) leaves it off, where a number beside the name says nothing. */
  count?: boolean
  view?: string
  /** The view the list opens on until the person picks one (their pick is kept under `preferenceKey`). `view`, when
   *  given, is the caller's own choice and wins over both. */
  defaultView?: string
  onViewChange?: (view: string) => void
  /** Grouping levels in order ("Project, then Captured by month"); the caller
   *  keeps them. Without them this surface keeps its own. */
  groupLevels?: GroupLevel[]
  /** The grouping the list starts with until the person chooses their own (kept under `preferenceKey`). */
  defaultGroupLevels?: GroupLevel[]
  onGroupLevelsChange?: (levels: GroupLevel[]) => void
  /** The person's order of every field (columns and filter-only facts), the
   *  one order the columns, Sort, Group and Filter menus share. New fields
   *  join at the end. Kept by the caller when given, else with this view's
   *  preferences. */
  fieldOrder?: string[]
  onFieldOrderChange?: (ids: string[]) => void
  /** A consumer-owned descriptor writer; created fields return through `fields`. */
  onAddField?: (field: Pick<FieldDescriptor, 'id' | 'label' | 'kind' | 'ruleKind' | 'filterable' | 'groupable'>) => void
  /** Open field-kind rows for the consumer's Add field form. */
  customFieldKinds?: CustomFieldKind[]
  /** Persist a changed value for one record and editable field. */
  onEditFieldValue?: (recordId: string, fieldId: string, value: string) => void | Promise<void>
  label?: string
  onOpen?: (id: string) => void
  /** Selection to restore when a loading or empty state remounts the view. */
  selected?: string[]
  onSelectionChange?: (ids: string[]) => void
  /** Right-click keeps an existing selection or selects the targeted record,
   * then gives the caller the same selection and pointer for its action menu. */
  onRowContextMenu?: (ids: string[], point: {x: number; y: number}) => void
  /** Every change to the rules and the search text, so a caller holding more
   *  records than the browser has can go and narrow them where they live. */
  onQueryChange?: (query: {search: string; rules: RuleGroup}) => void
  /** The comparisons a rule can use: formula-engine rules/rule-operators.json.
   *  Without them this surface offers no filter. */
  ruleOperators?: RuleOperatorData
  /** Rules in force when this surface mounts, usually a caller's saved view. */
  initialRules?: RuleGroup
  /** A starting filter only when no explicit or stored rules exist. */
  defaultRules?: RuleGroup
  /** Rules the caller holds and re-supplies (a controlled filter). */
  rules?: RuleGroup
  /** Loads the formula engine's record filter (formula-engine
   *  rules/filter-records.mjs) for records held here. It is called the first
   *  time a rule is in force, never before, so a list with no filter never
   *  fetches the engine. Without it the rules narrow nothing here and the
   *  caller narrows `records` itself from `onQueryChange`. */
  loadFilterRecords?: () => Promise<FilterRecords>
  /** Fields a person can filter by when they differ from the columns (facts
   *  measured for every record that are not shown as columns). */
  ruleFields?: RuleFieldView[]
  /** Value counts and ranges from the caller, which sees every record; when
   *  absent they are read from the records held here. */
  ruleFacets?: Record<string, RuleFacet>
  /** Named configurations owned and persisted by the caller. The shared surface owns
   *  the save/apply controls; the caller owns where these rows are stored. */
  savedViews?: SavedRecordView[]
  /** Saved view selected by the caller's address or server read. */
  initialSavedViewId?: string
  onSaveView?: (view: Omit<SavedRecordView, 'id'>) => void | Promise<void>
  onUpdateSavedView?: (view: SavedRecordView | (Pick<SavedRecordView, 'id' | 'label'> & Partial<Pick<SavedRecordView, 'display' | 'time' | 'time_zone' | 'aspects' | 'revision'>>)) => void | Promise<void>
  onRemoveSavedView?: (id: string) => void | Promise<void>
  onApplySavedView?: (view: SavedRecordView) => void
  onShareSavedView?: (id: string) => void | Promise<void>
  onCopySavedViewLink?: (id: string) => void | Promise<void>
  /** An authorized server resolves a time bound; referenced records stay there.
   *  Plain dates need no context. A formula without its resolver fails visibly closed. */
  configurationContext?: ConfigurationContext
  savedViewsState?: {loading?: boolean; error?: string; hasMore?: boolean}
  onReloadSavedViews?: () => void | Promise<void>
  onLoadMoreSavedViews?: () => void | Promise<void>
  /** The caller's own search, which reaches every record rather than only the
   *  ones loaded here. It is drawn in the view bar's search box (never a
   *  second box beside ours) and handed back when the person presses Enter,
   *  leaves the box, or clears it, and with `pauseMs` also when they stop
   *  typing for that long (a search that is quick to answer). Without it the
   *  box filters the loaded records as the person types. */
  search?: {value: string; placeholder?: string; onCommit: (value: string) => void; pauseMs?: number}
  /** Caller-drawn controls placed in the view bar right after the title (a
   *  folder path, a "Show older" button), so a surface has one toolbar row,
   *  never a second band above the view bar. Receives its host; may return a
   *  teardown. The host is replaced when the bar re-renders, so a caller holds
   *  its own element rather than a query into the host. */
  toolbarStart?: (host: HTMLElement) => void | (() => void)
  /** Caller controls at the end of the shared view bar, before its primary action. */
  toolbarEnd?: React.ReactNode
  /** Hide the shared view bar when embedding a focused sub-surface. */
  showToolbar?: boolean
  /** A menu of the caller's own actions for the whole collection (organize,
   *  find duplicates), drawn as the last tool in the view bar. `detail` is
   *  a state worth reading at rest ("Paused") and keeps it open; `badge` is
   *  a count on its icon ("14K" waiting to review). */
  moreActions?: {label: string; icon: string; detail?: string; badge?: string | number; items: ActionMenuItem[]; onAction: (id: string) => void}
  /** Actions offered for a selection. Shown in one bar that appears only while
   *  something is selected. */
  bulkActions?: BulkAction[]
  /** Actions offered for one record, behind a menu on its card or row. */
  rowActions?: BulkAction[]
  /** A field whose value cuts the run of records into labelled sections, the
   *  way a file list breaks into days. DATA: whichever field a caller names,
   *  including one computed by its own `read`, so nothing here knows about
   *  dates in particular. */
  groupDividerBy?: string
  /** What this list is, for what a view keeps for this list alone (a board's placement and drawings). Without it, the
   *  preference key. */
  identity?: string
  /** Stable identity for per-view preferences. When omitted, the visible schema
   * and label keep one user's widths and row density together across remounts. */
  preferenceKey?: string
  /** Dragging a record out of this surface. Receives the dragged records (the
   *  whole selection when the dragged one is selected, otherwise just it) and
   *  the browser drag event; the caller may add a tab or native-file payload.
   *  A supplied shareRecord also carries the selected references for a destination
   *  such as Your tray, independently of any caller-specific drag payload. */
  onDragOut?: (ids: string[], event: React.DragEvent) => void
  /** A shared status notice above retained records, such as incomplete source coverage. */
  status?: React.ReactNode
  /** How many records there are in all when `records` is one page of them
   *  (a caller that reads more on demand). The title's count shows it while
   *  nothing on the page is filtered out, so it never reads as the whole. */
  total?: number
  /** A caller that holds the first pages of its records and has more to read. It is asked for its next page, each time
   *  `records` changes until it stops passing this, while what is shown needs it: `end`, the end of what is drawn is
   *  within a screen of view; `search` and `rules`, a search or a rule is in force; `every`, a sort, grouping or time
   *  bound is in force or Select all is picking every record. All but `end` are decided over every record, so a caller
   *  reads on for them unless its own store already narrowed its records by them (a rule its store decides). */
  onReadMore?: (want: {end: boolean; search: boolean; rules: boolean; every: boolean}) => void
  emptyMessage?: string
  /** Shared empty or failure UI for an answered list with no visible records. */
  emptyContent?: React.ReactNode
  /** The one create action for these records ("Schedule a video", "New
   *  post"), drawn at the end of the view bar where people look for it and
   *  wrapping with the other bar actions in a narrow pane. */
  primaryAction?: {label: string; icon?: string; onSelect: () => void}
  /** What someone can do when nothing is shown ("Clear search and filters"). */
  emptyAction?: {label: string; onSelect: () => void}
  /** Fields that appear only in a gallery card's hover preview, after the
   *  record's own fields marked `preview` (a transcript passage, say). */
  previewFields?: FieldDescriptor[]
  /** Draws a record's content in its hover preview and selection carousel. Without it, the shared
   *  hover-preview screen its content type chooses. A host with one any-file preview passes it here. */
  renderPreview?: (item: PreviewItem) => React.ReactNode
  /** A dated field that lays the gallery out as a timeline, the way a photo
   *  library does: sections are calendar stretches, and pinching or ⌘+ / ⌘−
   *  zooms between levels, keeping the record under the pointer in place. The
   *  levels (tile size, stretch, heading) are DATA, usually
   *  `timeline-zoom-levels.json`. Applies while no Group by is chosen. */
  timeline?: {fieldId: string; levels: TimelineLevels; level?: string; onLevelChange?: (levelId: string) => void}
  /** How much a gallery or board card says at each step of a pinch (or ⌘+ / ⌘−, or the Zoom buttons): zooming out
   *  shows more, smaller cards that each say less, zooming in fewer that say more. DATA, `detail-levels.json` by
   *  default; `null` keeps every card as it is. A timeline gallery zooms through its own levels instead. */
  detailLevels?: DetailLevels | null
  /** Bring one record into view in its place, select it and mark it for a
   *  moment. A new `nonce` asks again for the same record. */
  reveal?: {id: string; nonce: number}
  /** Where this list sits among the levels a filter can be set at, widest
   *  first, ending with this list's own node ("app", then the screen). Every
   *  level's rule ANDs with the ones before it (../rule-filter/focus-chain);
   *  this list's own filter is the last level's rule. Default: the app, then
   *  this list's preference key. */
  focusPath?: string[]
  /** Where every level's rule is kept. Default: the person's own records. */
  nodeRules?: NodeRuleStore
  /** How records connect beyond the fields declaring `links` ("this message led to that task", a step's value flowing
   *  into the next): the lines a view joining records draws (Draw, the board). */
  links?: (records: any[]) => RecordLink[]
  /** The field whose value is each record's state where a view draws one (a card's live badge on the board): its
   *  `values` give each state's words, tone and whether it is still being worked on. Default: the field whose role is
   *  `status`, else the first whose values carry a tone. */
  statusField?: string
  /** What can be added to this list by kind (a step or a tool for a workflow), searched as the person types, where a
   *  view offers adding (the board's Add). Without it a list that keeps changes adds a new record named by the words. */
  adds?: RecordAdds
}

/** A line between two records of a list: where it leaves and arrives, the words on it, and what it carries (any word
 *  the list chooses: a kind of value, a kind of link), which a board colours it by. */
export type RecordLink = {from: string; to: string; label?: string; kind?: string}
/** One thing a list can add, as a search offers it. */
export type RecordAddRow = {id: string; label: string; icon?: string; detail?: string; section?: string}
/** What a list can add by kind: `search(words)` answers the rows to choose from, `add(kind, at)` adds one (at a board
 *  point when a board asked) and answers the new record's id. */
export type RecordAdds = {
  label: string
  placeholder?: string
  search: (words: string) => Promise<RecordAddRow[]> | RecordAddRow[]
  add: (kind: string, at?: {x: number; y: number}) => Promise<{id: string}>
}

// A press on one of these is that control's press, never a pick of the record
// it sits in or the start of a marquee.
const CONTROLS = 'button, input, textarea, select, a, label, [role="checkbox"], [role="menuitem"], [role="menu"], [contenteditable="true"]'

// The view switch's one menu holding the views offered to every list (its id is never a view's).
const MORE_VIEWS = 'more-views'
const DEFAULT_VIEWS: RecordView[] = [
  {id: 'gallery', label: 'Gallery', icon: 'LayoutGrid', fadeEdges: ['top', 'bottom']},
  {id: 'table', label: 'Table', icon: 'Table', fadeEdges: ['top', 'right', 'bottom', 'left']},
  // Columns of a field the list can group by: offered to any list holding one.
  {id: 'board', label: 'Board', icon: 'Kanban', fadeEdges: ['top', 'right', 'bottom', 'left'], offeredFor: fields => fields.some(field => field.groupable)},
  {id: 'sheet', label: 'Sheet', icon: 'Grid3x3', fadeEdges: ['top', 'bottom']},
  {id: 'changelog', label: 'Changelog', icon: 'History', fadeEdges: ['top', 'bottom']},
]
// Views every list offers beside the caller's own, since they need nothing but
// the records and fields every list already has: these four (the Board where a field groups), then each view a
// part offers to every list (every-list-views.ts).
const EVERY_LIST_VIEWS = DEFAULT_VIEWS.filter(option => option.id === 'board' || option.id === 'sheet' || option.id === 'changelog')
const VERTICAL: readonly ScrollFadeEdge[] = ['top', 'bottom']

const readField = (field: FieldDescriptor, record: any) =>
  field.read ? field.read(record) : record?.[field.id]

const asText = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(', ')
  if (value instanceof Date) return value.toLocaleDateString()
  if (typeof value === 'object') return String((value as any).label ?? (value as any).name ?? (value as any).id ?? '')
  return String(value)
}

const asList = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).map(asText)

const isDateField = (field: FieldDescriptor) => field.kind === 'date' || field.ruleKind === 'date'

// Grouping a date field means grouping by the person's calendar day, not by
// the exact instant a timestamp happened to record. Date-only values stay
// date-only; timestamps and Date objects use the configuration's calendar zone.
// The same engine supplies the group heading's instant range below.
const dateGroupingKey = (value: unknown, timeZone: string): string => {
  const key = calendarBucket(value instanceof Date ? value.getTime() : value, 'day', timeZone)
  return key === 'Empty' ? '' : key
}

const groupingValues = (field: FieldDescriptor, record: any, timeZone: string): string[] => {
  const raw = readField(field, record)
  return (Array.isArray(raw) ? raw : [raw]).map(value => isDateField(field) ? dateGroupingKey(value, timeZone) : asText(value)).filter(Boolean)
}

const groupingLabel = (field: FieldDescriptor, value: string): string => {
  const declared = field.values?.[value]?.label
  if (declared) return declared
  if (isDateField(field) && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number)
    const date = new Date(year, month - 1, day)
    return date.toLocaleDateString()
  }
  return readableValue(value)
}

// A machine key: lowercase words joined by _ or -, which is what a producer
// emits and never what a person should read. Anything else (a title, a name, a
// sentence, a value already carrying capitals or spaces) is left alone.
const MACHINE_KEY = /^[a-z0-9]+([_-][a-z0-9]+)*$/

// Descriptor DATA still owns the label wherever anyone cared to write one. This
// only decides what to show for the values nobody has named yet, so a new state
// a producer invents tomorrow reads as "Not checked" rather than "not_checked".
const readableValue = (value: string) =>
  MACHINE_KEY.test(value)
    ? value.replace(/[_-]+/g, ' ').replace(/^./, first => first.toUpperCase())
    : value

const formatFieldValue = (field: FieldDescriptor, record: any): string => {
  const raw = readField(field, record)
  return (Array.isArray(raw) ? raw : [raw]).map(value => {
    if (value === null || value === undefined || value === '') return ''
    const text = asText(value)
    if (isDateField(field)) {
      if (field.relativeDates) return relativeDate(text, Date.now(), {clock: true}) || text
      const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text)
      const date = new Date(dateOnly ? `${text}T12:00:00` : text)
      return Number.isNaN(date.getTime()) ? text : dateOnly ? date.toLocaleDateString() : date.toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'})
    }
    const declared = field.values?.[text]?.label
    if (declared) return declared
    if (typeof value === 'object' && !text) {
      try { return JSON.stringify(value) } catch { return String(value) }
    }
    return field.kind === 'tag' || field.kind === 'chip' ? readableValue(text) : text
  }).filter(Boolean).join(', ')
}

function Tag({value, field, count, active, onClick, displayLabel}: {value: string; field: FieldDescriptor; count?: number; active?: boolean; onClick?: () => void; displayLabel?: string}) {
  const declared = field.values?.[value]
  const label = displayLabel ?? declared?.label ?? readableValue(value)
  // A value inside another (a project in a project) says where it sits.
  const where = declared?.parent ? ancestry(field, value).map(step => field.values?.[step]?.label ?? readableValue(step)).join(' › ') : ''
  // Said as what it is, never a bare number: "40 items have Kind: Key".
  const holding = count === undefined ? '' : `${count.toLocaleString()} ${count === 1 ? 'item has' : 'items have'} ${field.label}: ${label}`
  const accessibleLabel = `${active ? 'Stop showing only' : 'Show only'} ${field.label}: ${label}${holding ? ` (${holding})` : ''}`
  return (
    <span className="record-view-tag-wrap" data-active={active || undefined}>
      <Badge
        className="record-view-tag"
        variant="outline"
        size="sm"
        data-tone={declared?.tone ?? toneForValue(value)}
        data-filterable={onClick ? 'true' : undefined}
        aria-label={onClick ? accessibleLabel : undefined}
        aria-pressed={onClick ? Boolean(active) : undefined}
        title={[where, onClick ? `${holding ? `${holding}. ` : ''}${active ? 'Press to show every item again' : 'Press to show only these'}` : ''].filter(Boolean).join(' · ') || undefined}
        {...(onClick ? {render: <button type="button"/>, onClick: (event: React.MouseEvent<HTMLButtonElement>) => {event.stopPropagation();onClick()}} : {})}
      >{declared?.working ? <Spinner size="sm" aria-hidden/> : null}{label}</Badge>
      {count !== undefined && <CountChip variant="neutral" size="sm" className="record-view-tag-count" aria-hidden="true">{count.toLocaleString()}</CountChip>}
    </span>
  )
}

// How each field kind draws. One row per kind, so a caller naming a kind nobody
// wrote falls through to text rather than rendering nothing.
// A `media` field's value as the item the shared hover preview shows. The
// value names its own content; `label` is the name it goes by.
function previewItemOf(raw: unknown, id: string): PreviewItem | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown> & Partial<PreviewItem>
  if (!value.url && !value.poster && !value.text && !value.peaks && !value.peaksUrl) return null
  return {...value, id: asText(value.id) || id, title: asText(value.label ?? value.title)}
}

const DRAW: Record<string, (raw: unknown, field: FieldDescriptor) => React.ReactNode> = {
  tag: (raw, field) => <>{asList(raw).filter(Boolean).map((value, index) => <Tag key={`${value}:${index}`} value={value} field={field}/>)}</>,
  chip: (raw, field) => DRAW.tag(raw, field),
  thumbnail: raw => {
    const source = asText(raw)
    return source
      ? <img className="record-view-thumbnail" src={source} alt="" loading="lazy" decoding="async"/>
      : <span className="record-view-thumbnail record-view-thumbnail-absent" aria-hidden="true"/>
  },
  // A passage quoted from the record, a few lines at most.
  excerpt: raw => <span className="record-view-excerpt">{asText(raw)}</span>,
  // What kind of record this is (original, draft, project), from the shared
  // record-kind appearance DATA.
  'record-kind': raw => <RecordKindMark kind={asText(raw)}/>,
  // How much of something is done, as a whole percentage: the shared bar with the number beside it.
  progress: raw => {
    const share = raw === null || raw === undefined || raw === '' ? NaN : Number(raw)
    if (!Number.isFinite(share)) return <span className="record-views-empty-cell">&mdash;</span>
    const percent = Math.max(0, Math.min(100, Math.round(share)))
    return (
      <span className="record-view-progress">
        <ProgressBar className="record-view-progress-bar" percentage={percent} color="var(--record-kind-green, var(--color-success))" aria-hidden="true"/>
        <span className="record-view-progress-value">{`${percent}%`}</span>
      </span>
    )
  },
  // The record's own content (a PreviewItem-like `{url, type, poster, frames,
  // peaks, text, label}`), drawn by the shared hover-preview screen its content
  // type chooses.
  media: (raw, field) => {
    const item = previewItemOf(raw, field.id)
    return item ? <PreviewScreen item={item}/> : null
  },
}

/** A rule in a few words for its chip: the values it asks for, else its fields. */
function ruleWords(node: RuleNode): string {
  if (isGroup(node)) return node.rules.map(ruleWords).filter(Boolean).join(', ')
  const values = node.params.values ?? node.params.value
  const said = (Array.isArray(values) ? values : values === undefined || values === null ? [] : [values]).map(asText).filter(Boolean)
  return said.length ? said.join(', ') : node.field
}

/** How many records hold a value of a field. */
type CountOf = (field: FieldDescriptor, value: string) => number

function Cell({field, record, countOf, rules, onTagFilter}: {field: FieldDescriptor; record: any; countOf?: CountOf; rules?: RuleGroup; onTagFilter?: (field: FieldDescriptor, value: string) => void}) {
  if (field.render) return <>{field.render(record)}</>
  const raw = readField(field, record)
  const draw = DRAW[field.kind ?? '']
  if (field.kind === 'tag' || field.kind === 'chip') return <>{asList(raw).filter(Boolean).map((value, index) => {
    const count = countOf ? countOf(field, value) : undefined
    const active = Boolean(rules && holdsValue(rules, field.id, value))
    return <Tag key={`${value}:${index}`} value={value} field={field} count={count} active={active} onClick={field.filterable ? () => onTagFilter?.(field, value) : undefined}/>
  })}</>
  if (draw) return <>{draw(raw, field)}</>
  if (raw === null || raw === undefined || raw === '') return <span className="record-views-empty-cell">&mdash;</span>
  return <>{asText(raw)}</>
}

// A field's mark for one record, drawn before its value: a named icon, or the
// caller's own node. The part never knows what a mark means.
function Mark({field, record}: {field: FieldDescriptor; record: any}) {
  const mark = field.mark?.(record)
  if (!mark) return null
  if (React.isValidElement(mark)) return <span className="record-views-mark" aria-hidden="true">{mark}</span>
  const {icon, label} = mark as {icon: string; label?: string}
  return (
    <span className="record-views-mark" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} title={label}>
      <NamedIcon name={icon} size="xs" aria-hidden/>
    </span>
  )
}

// A value that asks for something opens its answer form on hover; any other value is drawn as it is.
function asked(field: FieldDescriptor, record: any, drawn: React.ReactElement) {
  const form = field.hoverForm?.(record)
  return form ? <React.Suspense fallback={drawn}><HoverFormCell form={form}>{drawn}</HoverFormCell></React.Suspense> : drawn
}

// One line of a hover preview: the field's name and its value. A field with
// `load` reads when the preview opens; an empty value leaves the line out.
function PreviewField({field, record, recordId}: {field: FieldDescriptor; record: any; recordId: string}) {
  const [loaded, setLoaded] = useState<unknown>(undefined)
  const load = field.load
  useEffect(() => {
    if (!load) return
    let live = true
    load(record).then(value => { if (live) setLoaded(value) }, () => {})
    return () => { live = false }
    // The record's identity, not its object, decides what to read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field.id, recordId])
  const value = load ? loaded : readField(field, record)
  if (asText(value) === '') return null
  const draw = DRAW[field.kind ?? '']
  const drawn = !load && field.render ? field.render(record)
    : field.kind === 'tag' || field.kind === 'chip' ? asList(value).filter(Boolean).map((one, index) => <Tag key={`${one}:${index}`} value={one} field={field}/>)
    : draw ? draw(value, field) : asText(value)
  return (
    <div className="record-preview-field" data-kind={field.kind ?? 'text'}>
      <dt>{field.label}</dt>
      <dd>{field.kind === 'transcript'
        ? <div className="record-preview-transcript" tabIndex={0} aria-label={`${field.label} text`}>{asText(value)}</div>
        : drawn}</dd>
    </div>
  )
}

/** What a group holds, read from its own records: how many, the span of time
 *  it covers, the values that recur most in each field that names values
 *  (kinds, projects, tags), and the first few records by name. */
function GroupSummary({trigger, node, fields, name, timeZone}: {trigger: React.ReactElement<Record<string, unknown>>; node: SectionNode; fields: FieldDescriptor[]; name: (record: any) => string; timeZone?: string}) {
  const records = recordsIn(node)
  const facets = fields
    .filter(field => field.id !== node.fieldId && (field.values || field.kind === 'tag'))
    .map(field => {
      const counts = new Map<string, number>()
      for (const record of records) for (const value of asList(readField(field, record))) if (value) counts.set(value, (counts.get(value) ?? 0) + 1)
      const top = [...counts].sort((left, right) => right[1] - left[1]).slice(0, 3)
      return {field, top}
    })
    .filter(facet => facet.top.length > 0)
    .slice(0, 3)
  const day = (time: number) => new Date(time).toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric', timeZone})
  const span = node.range ? `${day(node.range.min)} – ${day(node.range.max)}` : ''
  const named = records.slice(0, 5).map(name)
  if (!cardShown(CARD_CONTROLS.list)) return trigger
  return (
    <PreviewCard.Root>
      <PreviewCard.Trigger render={trigger} delay={600} closeDelay={120}/>
      <PreviewCard.Portal>
        <PreviewCard.Positioner side="bottom" align="start" sideOffset={6} collisionPadding={12} style={{zIndex: LAYER_ORDER.menu}}>
          <PreviewCard.Popup className="coss-ui record-group-summary" data-slot="record-group-summary">
            <strong className="record-group-summary-title">{node.label}</strong>
            <span className="record-group-summary-meta">{records.length.toLocaleString()} {records.length === 1 ? 'item' : 'items'}{span ? ` · ${span}` : ''}</span>
            {facets.map(({field, top}) => (
              <div key={field.id} className="record-group-summary-facet">
                <span className="record-group-summary-field">{field.label}</span>
                <span className="record-group-summary-values">{top.map(([value, count]) => `${field.values?.[value]?.label ?? value} ${count.toLocaleString()}`).join(' · ')}</span>
              </div>
            ))}
            {named.length > 0 && (
              <ul className="record-group-summary-names">
                {named.map((one, index) => <li key={index}>{one}</li>)}
                {records.length > named.length && <li className="record-group-summary-more">and {(records.length - named.length).toLocaleString()} more</li>}
              </ul>
            )}
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  )
}

/** One record's facts as name/value rows, the same rows a record's hover preview opens, for a page that shows one record
 *  (a recording, a file, a decision): each field a descriptor, an empty value leaving its row out. */
export function RecordFacts({fields, record, recordId, label}: {fields: FieldDescriptor[]; record: any; recordId: string; label?: string}) {
  return (
    <Card className="record-facts" data-slot="record-facts" aria-label={label}>
      {fields.map(field => <PreviewField key={field.id} field={field} record={record} recordId={recordId}/>)}
    </Card>
  )
}

// A record's facts wait behind one info button in its hover preview: pointing at the button (or pressing it, for touch
// and keyboard) opens them in the card under its actions, so the card leads with the content and what can be done with
// it. They open inside the card, never in a popup of their own, so moving to read them never leaves the card. A field
// that reads its value (`load`) reads it only once they are opened. No facts, no button.
function PreviewFactsButton({facts, name, open, onOpen}: {facts: FieldDescriptor[]; name: string; open: boolean; onOpen: (open: boolean) => void}) {
  if (facts.length === 0) return null
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="record-preview-info"
      aria-label={open ? `Hide details of ${name}` : `Details of ${name}`}
      aria-expanded={open}
      data-open={open ? '' : undefined}
      onPointerEnter={() => onOpen(true)}
      onClick={() => onOpen(!open)}
    >
      <NamedIcon name="Info" aria-hidden="true"/>
    </Button>
  )
}

function PreviewFactsPanel({facts, record, recordId, open, primary = false}: {facts: FieldDescriptor[]; record: any; recordId: string; open: boolean; primary?: boolean}) {
  if (!open || facts.length === 0) return null
  return (
    <Card className="record-preview-facts" data-slot="record-preview-facts" data-priority={primary ? 'primary' : 'more'}>
      {facts.map(field => <PreviewField key={field.id} field={field} record={record} recordId={recordId}/>)}
    </Card>
  )
}

// What a hover preview shows under a record's content: the title line with
// any `heading` field beside it, the record's useful facts immediately below
// it, the lead actions as buttons with the rest under ⋯, and the remaining
// fields behind the info button. The content
// itself (a video playing in the shared player, a recording's waveform, a
// document's first page) is the shared HoverPreview screen, read from the
// record's `media` field; the card never repeats the tile's picture.
function RecordPreviewDetails({record, recordId, name, fields, actions, about, onOpen}: {record: any; recordId: string; name: string; fields: FieldDescriptor[]; actions: BulkAction[]; about?: MenuThing; onOpen?: (id: string) => void}) {
  const available = actions.filter(action => !action.appliesTo || action.appliesTo(record))
  const lead = available.filter(action => action.lead)
  // A heading fact that says the same as the name (a post named by its own words) would draw the name twice.
  const heading = fields.filter(field => field.preview === 'heading' && String(readField(field, record) ?? '').trim() !== name.trim())
  const facts = fields.filter(field => field.preview !== 'heading' && field.kind !== 'media' && (field.load || asText(readField(field, record)) !== ''))
  // A marked field is editorially important. Otherwise the first few facts from the record's visible columns give
  // the card an immediate, useful answer. Every other fact stays available without making a long hover card.
  const primary = facts.filter(field => field.preview === true).slice(0, 3)
  for (const field of facts) if (primary.length < 3 && !primary.includes(field)) primary.push(field)
  const more = facts.filter(field => !primary.includes(field))
  const [factsOpen, setFactsOpen] = useState(false)
  return (
    <>
      <div className="record-preview-heading">
        <strong className="record-preview-title">{name}</strong>
        {heading.map(field => <span key={field.id} className="record-preview-heading-fact"><Cell field={field} record={record}/></span>)}
        {/* With no buttons to sit beside, the info button sits beside the name. */}
        {available.length === 0 && !about && !onOpen && <PreviewFactsButton facts={more} name={name} open={factsOpen} onOpen={setFactsOpen}/>}
      </div>
      {primary.length > 0 && <PreviewFactsPanel facts={primary} record={record} recordId={recordId} open primary />}
      {(available.length > 0 || about || onOpen) && (
        <div className="record-preview-actions" role="group" aria-label={`Actions for ${name}`}>
          {onOpen && !available.some(action => action.id === 'open') && (
            <Button type="button" variant="outline" size="sm" onClick={() => onOpen(recordId)}>
              <NamedIcon name="ArrowUpRight" aria-hidden="true" />Open
            </Button>
          )}
          {lead.map(action => (
            <Button key={action.id} variant="outline" size="sm" onClick={() => action.run([recordId])}>
              <NamedIcon name={action.icon} aria-hidden="true"/>{action.label}
            </Button>
          ))}
          {(available.length > lead.length || about) && <RowActionMenu actions={available.filter(action => !action.lead)} record={record} id={recordId} name={name} about={about}/>}
          <PreviewFactsButton facts={more} name={name} open={factsOpen} onOpen={setFactsOpen}/>
        </div>
      )}
      <PreviewFactsPanel facts={more} record={record} recordId={recordId} open={factsOpen}/>
    </>
  )
}

function EditableCell({field, record, recordId, countOf, onTagFilter, onCommit, onEditingChange}: {
  field: FieldDescriptor
  record: any
  recordId: string
  countOf: CountOf
  onTagFilter: (field: FieldDescriptor, value: string) => void
  onCommit: (value: string) => void | Promise<void>
  onEditingChange?: (editing: boolean) => void
}) {
  const [editing, setEditing] = useState(false)
  const editingNotice = useRef(onEditingChange)
  editingNotice.current = onEditingChange
  useEffect(() => {
    editingNotice.current?.(editing)
    return () => editingNotice.current?.(false)
  }, [editing])
  const [saving, setSaving] = useState(false)
  const saveInFlight = useRef(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const raw = readField(field, record)
  // A date is edited as the day it is (the date box's own form), whatever words the field draws it with.
  const day = isDateField(field) ? factOf(field, field.id, record) : null
  const text = typeof day === 'number' ? localDay(day) : Array.isArray(raw) ? raw.join(', ') : raw === null || raw === undefined ? '' : String(raw)
  const recordLabel = String(record?.title ?? record?.name ?? record?.id ?? recordId)
  const [draft, setDraft] = useState(text)
  const inputType = field.kind === 'date' || field.kind === 'number' ? field.kind : 'text'
  const begin = () => { setDraft(text); setSaveError(null); setEditing(true) }
  // Picker results close on blur. Keep focus until these actions run, so a collapsing result list cannot move a
  // pressed button away between mouse-down and click. Keyboard activation follows the same ordinary onClick.
  const holdPickerFocus = (event: React.MouseEvent) => event.preventDefault()
  const finish = async (save: boolean, value = draft) => {
    // Disabling a focused input can emit blur after Enter. Both gestures
    // belong to the same attempted save, including when the owner refuses it.
    if (saveInFlight.current) return
    const committed = field.records ? recordText(value) : value
    if (!save || committed === text) { setEditing(false); setSaveError(null); return }
    saveInFlight.current = true
    setSaving(true)
    setSaveError(null)
    try {
      await onCommit(committed)
      setEditing(false)
    } catch (error) {
      setDraft(value)
      setSaveError(errorWords(error, `The ${field.label.toLowerCase()} could not be saved.`))
    } finally {
      saveInFlight.current = false
      setSaving(false)
    }
  }

  if (field.links) return (
    <React.Suspense fallback={<Spinner aria-label={`${field.label} for ${recordLabel}`} />}>
    <LinkCell name={field.id} label={`${field.label} for ${recordLabel}`} links={field.links.current(record)} from={field.links.from} source={field.links.source}
      onChange={ids => onCommit(ids.join(','))} />
    </React.Suspense>
  )

  if (field.document) return (
    <Popover open={editing} onOpenChange={setEditing}>
      <PopoverTrigger render={<Button variant="ghost" size="sm" aria-label={`Edit ${field.label} for ${recordLabel}`} onClick={begin} /> }>
        <Cell field={{...field, filterable: false}} record={record} countOf={countOf} onTagFilter={onTagFilter}/>
      </PopoverTrigger>
      <PopoverPopup preserveContent align="start" className="record-views-notes-popup" portalProps={{className: 'coss-ui', keepMounted: true}}>
        <React.Suspense fallback={<Spinner aria-label={`${field.label} for ${recordLabel}`} />}>
          <NotesDocument text={draft} label={`${field.label} for ${recordLabel}`} onKeep={async value => { await onCommit(value); setDraft(value) }} />
        </React.Suspense>
      </PopoverPopup>
    </Popover>
  )

  if (field.records) return (
    <Popover open={editing} onOpenChange={setEditing}>
      <PopoverTrigger render={<Button variant="ghost" size="sm" aria-label={`Edit ${field.label} for ${recordLabel}`} onClick={begin} />}>
        <Cell field={{...field, filterable: false}} record={record} countOf={countOf} onTagFilter={onTagFilter}/>
      </PopoverTrigger>
      <PopoverPopup preserveContent align="start" className="record-views-notes-popup" portalProps={{className: 'coss-ui', keepMounted: true}}>
    <div role="group" aria-label={`Edit ${field.label} for ${recordLabel}`} className="record-views-edit-cell">
      <React.Suspense fallback={<Spinner aria-label={`${field.label} for ${recordLabel}`} />}>
        {saving ? <Spinner aria-label={`Saving ${field.label.toLowerCase()}`} /> : <RecordPicker name={field.id} label={`${field.label} for ${recordLabel}`} value={draft} from={field.records.from}
          made={field.records.made} source={field.records.source} autoFocus
          onChange={value => { setDraft(value); void finish(true, value) }} />}
      </React.Suspense>
      <Button type="button" variant="ghost" size="sm" disabled={saving} onMouseDown={holdPickerFocus} onClick={() => finish(false)}>Cancel</Button>
      {text && <Button type="button" variant="ghost" size="sm" disabled={saving} onMouseDown={holdPickerFocus} onClick={() => { setDraft(''); void finish(true, '') }}>Clear</Button>}
      {saveError && <div role="alert" className="record-views-edit-error">
        <span>{saveError}</span>
        <Button type="button" variant="outline" size="sm" disabled={saving} onMouseDown={holdPickerFocus} onClick={() => finish(true, draft)}>Retry save</Button>
      </div>}
    </div>
      </PopoverPopup>
    </Popover>
  )

  if (editing && isDateField(field)) return (
    <React.Suspense fallback={<Spinner aria-label={`${field.label} for ${recordLabel}`} />}>
      <InlineDatePicker aria-label={`${field.label} for ${recordLabel}`} value={draft || null} defaultOpen
        onOpenChange={open => { if (!open) setEditing(false) }}
        onChange={day => { if ((day ?? '') !== text) onCommit(day ?? ''); setEditing(false) }} />
    </React.Suspense>
  )

  if (editing) return (
    <div role="group" aria-label={`Edit ${field.label} for ${recordLabel}`} className="record-views-edit-cell">
      <Input
        aria-label={`${field.label} for ${recordLabel}`}
        type={inputType}
        value={draft}
        autoFocus
        disabled={saving}
        onChange={event => setDraft(event.currentTarget.value)}
        onBlur={event => { if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) void finish(true) }}
        onKeyDown={event => {
          event.stopPropagation()
          if (event.key === 'Enter') { event.preventDefault(); void finish(true) }
          if (event.key === 'Escape') { event.preventDefault(); void finish(false) }
        }}
      />
      {saveError && <div role="alert" className="record-views-edit-error">
        <span>{saveError}</span>
        <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => finish(true, draft)}>Retry save</Button>
      </div>}
    </div>
  )

  return (
    <Button variant="ghost" size="sm" aria-label={`Edit ${field.label} for ${recordLabel}`} onClick={begin}>
      <Cell field={{...field, filterable: false}} record={record} countOf={countOf} onTagFilter={onTagFilter}/>
    </Button>
  )
}

/** The order a field's groups appear in: the order its declared `values`
 *  DATA lists them (a caller's own sequence, such as the stages of work), then
 *  any undeclared value alphabetically. One comparator, so the list's
 *  sections and the board's columns can never disagree. */
function groupComparator(field: FieldDescriptor): (left: string, right: string) => number {
  const declared = Object.keys(field.values ?? {})
  const rank = (value: string) => { const index = declared.indexOf(value); return index < 0 ? declared.length : index }
  return (left, right) => rank(left) - rank(right) || left.localeCompare(right, undefined, {numeric: true})
}

/** The value a rule compares for one record: the field's own fact reader, a
 *  date field's time as milliseconds (the same day meaning its groups use),
 *  or the value as read. */
function factOf(field: FieldDescriptor | undefined, id: string, record: any): unknown {
  if (!field) return record?.[id]
  if (field.factValue) return field.factValue(record)
  const raw = readField(field, record)
  if (!isDateField(field)) return raw
  const time = Date.parse(asText(raw))
  return Number.isFinite(time) ? time : null
}

/** A time as its local calendar day, the form a date box reads and writes ("2026-09-03"). */
function localDay(time: number): string {
  const date = new Date(time)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** A calendar day as the milliseconds it covers in the selected configuration. */
function dayRange(day: string, timeZone: string): {min: number; max: number} | null {
  const range = calendarBucketSpan(calendarBucket(day, 'day', timeZone), 'day', timeZone)
  return range ? {min: range.min, max: range.max} : null
}

/** Value counts and ranges over the records held here, for a caller that
 *  supplies none. Strings are counted, numbers bound a range; no field kind is
 *  named, so a field of a new kind still gets whichever applies. */
function localFacets(fields: RuleFieldView[], records: any[], valueOf: (fieldId: string, record: any) => unknown): Record<string, RuleFacet> {
  const facets: Record<string, RuleFacet> = {}
  for (const field of fields) {
    const counts = new Map<string, number>()
    let min: number | null = null, max: number | null = null
    for (const record of records) {
      const value = valueOf(field.id, record)
      for (const item of Array.isArray(value) ? value : [value]) {
        if (typeof item === 'number' && Number.isFinite(item)) { min = min === null ? item : Math.min(min, item); max = max === null ? item : Math.max(max, item) }
        else if (typeof item === 'string' && item) counts.set(item, (counts.get(item) ?? 0) + 1)
      }
    }
    facets[field.id] = {options: [...counts].map(([value, count]) => ({value, count})), min, max}
  }
  return facets
}

export function RecordViews({
  fields,
  records: sourceRecords,
  derivedReadProjection,
  identify = defaultRecordId,
  shareRecord,
  aboutRecord,
  nesting,
  write,
  reread,
  compose,
  designExtras,
  designAction,
  views: givenViews = DEFAULT_VIEWS,
  onlyTheseViews = false,
  count: showCount = true,
  view: givenView,
  defaultView,
  onViewChange,
  groupLevels: givenLevels,
  defaultGroupLevels,
  onGroupLevelsChange,
  fieldOrder: givenFieldOrder,
  onFieldOrderChange,
  onAddField,
  customFieldKinds,
  onEditFieldValue,
  label = 'Records',
  onOpen,
  selected: initialSelected,
  onSelectionChange,
  onRowContextMenu,
  onQueryChange,
  ruleOperators,
  initialRules,
  defaultRules,
  rules: controlledRules,
  loadFilterRecords,
  ruleFields: givenRuleFields,
  ruleFacets,
  savedViews = [],
  initialSavedViewId,
  onSaveView,
  onUpdateSavedView,
  onRemoveSavedView,
  onApplySavedView,
  onShareSavedView,
  onCopySavedViewLink,
  savedViewsState,
  onReloadSavedViews,
  onLoadMoreSavedViews,
  configurationContext,
  search: callerSearch,
  toolbarStart,
  toolbarEnd,
  showToolbar = true,
  moreActions,
  bulkActions: bulkActionsOffered = [],
  rowActions: rowActionsOffered = [],
  groupDividerBy,
  preferenceKey,
  identity,
  onDragOut,
  status,
  total,
  onReadMore,
  emptyMessage = 'Nothing here yet.',
  emptyContent,
  primaryAction,
  emptyAction,
  previewFields = [],
  renderPreview,
  timeline,
  detailLevels = DEFAULT_DETAIL_LEVELS,
  reveal,
  focusPath,
  nodeRules = nodeRuleStore(),
  links,
  statusField,
  adds,
}: RecordViewsOptions) {
  useShowChange()
  const [derivedProjectionRetry, setDerivedProjectionRetry] = useState(0)
  const derivedProjectionInput = useMemo(() => derivedReadProjection
    ? {records: sourceRecords, fields, projector: derivedReadProjection, retry: derivedProjectionRetry}
    : null, [derivedReadProjection, sourceRecords, fields, derivedProjectionRetry])
  const currentDerivedProjectionInput = useRef(derivedProjectionInput)
  currentDerivedProjectionInput.current = derivedProjectionInput
  const [derivedProjection, setDerivedProjection] = useState<{input: typeof derivedProjectionInput; records: readonly any[]; error?: true; incomplete?: true} | null>(null)
  useEffect(() => {
    if (!derivedProjectionInput) return
    let current = true
    derivedProjectionInput.projector.project(derivedProjectionInput.records, derivedProjectionInput.fields).then(projected => {
      if (current && currentDerivedProjectionInput.current === derivedProjectionInput) {
        setDerivedProjection({input: derivedProjectionInput, records: projected.records, incomplete: projected.incomplete})
      }
    }, () => {
      if (current && currentDerivedProjectionInput.current === derivedProjectionInput) {
        setDerivedProjection({input: derivedProjectionInput, records: [], error: true})
      }
    })
    return () => {current = false}
  }, [derivedProjectionInput])
  const derivedProjectionPending = Boolean(derivedProjectionInput && derivedProjection?.input !== derivedProjectionInput)
  const derivedProjectionError = Boolean(derivedProjectionInput
    && derivedProjection?.input === derivedProjectionInput
    && derivedProjection.error)
  const derivedProjectionIncomplete = Boolean(derivedProjectionInput
    && derivedProjection?.input === derivedProjectionInput
    && derivedProjection.incomplete)
  const records = useMemo(() => derivedProjectionInput
    ? derivedProjection?.input === derivedProjectionInput && !derivedProjection.error
      ? [...derivedProjection.records]
      : [...(derivedProjectionInput.projector.pending?.(sourceRecords, fields) ?? sourceRecords)]
    : sourceRecords, [derivedProjectionInput, derivedProjection, sourceRecords, fields])
  // Every action is a control the person's show rules decide (`record.action.<id>`): one rule on `record.action` holds for every action in every list, and a new action is shown or hidden with no code here.
  const bulkActions = bulkActionsOffered.filter(action => controlShown(`record.action.${action.id}`))
  const rowActions = rowActionsOffered.filter(action => controlShown(`record.action.${action.id}`))
  const resolvedPreferenceKey = preferenceKey ?? `record-views:${label}:${fields.map(field => field.id).sort().join(',')}`
  const surface = useRef<HTMLElement | null>(null)
  const sourceIds = useMemo(() => sourceRecords.map(record => identify(record)), [sourceRecords, identify])
  const arrived = useArrivals(resolvedPreferenceKey, sourceIds, surface)
  const accountPreferences = useRecordViewPreference<ViewPreferences>(resolvedPreferenceKey)
  const readPreferences = (): ViewPreferences => {
    if (accountPreferences && typeof accountPreferences === 'object') return accountPreferences
    try {
      const stored = localStorage.getItem(resolvedPreferenceKey)
      return stored ? JSON.parse(stored) as ViewPreferences : {}
    } catch { return {} }
  }
  // A person's own designed views (./view-designs), kept as one of their records, are offered on every list they fit.
  const keptDesigns = useRecordViewPreference<unknown>(DESIGNED_VIEWS_PREFERENCE)
  const views = useMemo(() => {
    if (onlyTheseViews) return givenViews
    const own = keptRows(keptDesigns).flatMap(row => {
      const option = designedRecordView(row)
      return option && (!option.offeredFor || option.offeredFor(fields, nesting)) ? [option] : []
    })
    const offered = [...EVERY_LIST_VIEWS.filter(option => !option.offeredFor || option.offeredFor(fields, nesting)), ...viewsOfferedToEveryList(fields, nesting), ...own]
    // A view the caller only names (no render of its own) that a part draws is drawn by that part: the caller chooses
    // which views lead and in what order, the part draws them (the one Draw wherever a list names its canvas).
    const drawn = (mine: RecordView) => (mine.render || mine.mount ? mine : offered.find(option => option.id === mine.id && (option.render || option.mount)) ?? mine)
    return [...givenViews.map(drawn), ...offered.filter((option, index) => !givenViews.some(mine => mine.id === option.id) && offered.findIndex(other => other.id === option.id) === index)]
  }, [givenViews, onlyTheseViews, fields, nesting, keptDesigns])
  const savedView = readPreferences().view
  const offeredView = (id: string | undefined) => (id && views.some(option => option.id === id) ? id : undefined)
  const firstView = givenView ?? offeredView(savedView) ?? offeredView(defaultView) ?? views[0]?.id ?? 'table'
  const [view, setView] = useState(firstView)
  // A caller that owns the view (its own saved preference, a deep link)
  // re-renders us with a new `view`. State initialisers only run on the first
  // render, so without this the caller's switch is silently ignored for the
  // whole life of the mount and the surface looks frozen on whichever view
  // mounted first.
  const [lastGivenView, setLastGivenView] = useState(givenView ?? firstView)
  const callerView = views.find(option => option.id === view && (option.mount || option.render))
  if (givenView !== undefined && givenView !== lastGivenView) {
    setLastGivenView(givenView)
    setView(givenView)
  }

  const initialSaved = savedViews.find(candidate => candidate.id === initialSavedViewId)
  const initialIncludes = (aspect: string) => Boolean(initialSaved && (initialSaved.aspects === undefined || initialSaved.aspects.includes(aspect)))
  const [search, setSearch] = useState(initialIncludes('search') ? initialSaved?.search ?? '' : '')
  // The words in the caller's search box before they are handed back. A new
  // value from the caller (a saved view, a cleared lens) replaces them.
  const [draft, setDraft] = useState(callerSearch?.value ?? '')
  const [lastCallerSearch, setLastCallerSearch] = useState(callerSearch?.value ?? '')
  if (callerSearch && callerSearch.value !== lastCallerSearch) {
    setLastCallerSearch(callerSearch.value)
    setDraft(callerSearch.value)
  }
  // With pauseMs the words are handed back once the person stops typing.
  const pauseMs = callerSearch?.pauseMs
  const commitSearch = callerSearch?.onCommit
  const committedSearch = callerSearch?.value
  useEffect(() => {
    if (!pauseMs || !commitSearch || draft === committedSearch) return
    const timer = window.setTimeout(() => commitSearch(draft), pauseMs)
    return () => window.clearTimeout(timer)
  }, [draft, pauseMs, commitSearch, committedSearch])
  const [sort, setSort] = useState<{fieldId: string; direction: 'asc' | 'desc'} | null>(() => initialIncludes('sort') && initialSaved?.sort?.[0] ? {fieldId: initialSaved.sort[0].field, direction: initialSaved.sort[0].direction} : null)
  const [secondarySort, setSecondarySort] = useState<NonNullable<SavedRecordView['sort']>>(() => initialIncludes('sort') ? initialSaved?.sort?.slice(1) ?? [] : [])
  // The levels above this list and its own, widest first. This list's own
  // filter is its node's rule, kept with every other level's.
  const chainPath = useMemo(() => focusPath ?? ['app', resolvedPreferenceKey], [focusPath, resolvedPreferenceKey])
  const ownNode = chainPath[chainPath.length - 1]!
  const [storedRules, setStoredRules] = useState(() => nodeRules.read())
  useEffect(() => {
    setStoredRules(nodeRules.read())
    return nodeRules.subscribe(() => setStoredRules(nodeRules.read()))
  }, [nodeRules])
  const blank = (): RuleGroup => (ruleOperators ? emptyGroup(ruleOperators) : {kind: 'group', combinator: '', negate: false, rules: []})
  const [ownRules, setOwnRules] = useState<RuleGroup>(() => (initialIncludes('rules') ? initialSaved?.rules : undefined) ?? initialRules ?? storedRules[ownNode] ?? defaultRules ?? blank())
  // A change to this node's rule from elsewhere (another tab, the column menu
  // of a list sharing this node) replaces what this list holds.
  const lastStoredOwn = useRef(storedRules[ownNode])
  if (storedRules[ownNode] !== lastStoredOwn.current) {
    lastStoredOwn.current = storedRules[ownNode]
    const next = storedRules[ownNode] ?? blank()
    if (JSON.stringify(next) !== JSON.stringify(ownRules)) setOwnRules(next)
  }
  const rules = controlledRules ?? ownRules
  const [savingView, setSavingView] = useState(false)
  const [savedViewName, setSavedViewName] = useState('')
  const [activeSavedId, setActiveSavedId] = useState<string | null>(initialSavedViewId ?? null)
  const [editingSavedId, setEditingSavedId] = useState<string | null>(null)
  const [editingTime, setEditingTime] = useState(false)
  const [askingRemoveView, setAskingRemoveView] = useState(false)
  const [savingAspects, setSavingAspects] = useState<string[]>(() => configurationAspects.map(aspect => aspect.id))
  const [configurationError, setConfigurationError] = useState<string | null>(null)
  const [configurationBusy, setConfigurationBusy] = useState(false)
  const configurationPending = useRef(false)
  const protectedConfigurationAspects = useRef(new Set<string>())
  const [configurationTime, setConfigurationTime] = useState<SavedViewTime>(() => initialIncludes('time') ? initialSaved?.time ?? null : null)
  const [configurationTimeZone, setConfigurationTimeZone] = useState(() => initialIncludes('time') ? initialSaved?.time_zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialSelected ?? []))
  // The selection bar's action waiting on its Yes; a new selection drops the question.
  const [askingId, setAskingId] = useState<string | null>(null)
  const asking = askingId ? bulkActions.find(action => action.id === askingId && action.confirm) ?? null : null
  // A caller that changes the selection itself (its own Select all, a record
  // it reveals) re-renders with a different list; the same members in a new
  // array are not a change.
  const [lastGivenSelected, setLastGivenSelected] = useState(initialSelected)
  if (initialSelected !== lastGivenSelected) {
    setLastGivenSelected(initialSelected)
    if (initialSelected && (initialSelected.length !== selected.size || initialSelected.some(id => !selected.has(id)))) setSelected(new Set(initialSelected))
  }
  // Field order and visibility are this surface's own state, seeded from the
  // descriptor order. Reordering is a person's arrangement of someone else's
  // list, so it is held as ids rather than by mutating the caller's array.
  const [ownOrder, setOwnOrder] = useState<string[] | null>(initialIncludes('columns') ? initialSaved?.columns?.order ?? null : null)
  // One stored record per view holds every column choice a person makes:
  // widths, density, order, which fields are hidden, how each column aligns
  // and how many columns stay frozen at the left.
  const [hidden, setHiddenState] = useState<Set<string>>(
    () => new Set((initialIncludes('columns') ? initialSaved?.columns?.hidden : undefined) ?? readPreferences().hidden ?? fields.filter(field => field.hiddenByDefault).map(field => field.id)))
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() => readPreferences().columnWidths ?? {})
  const [compactRows, setCompactRows] = useState(() => readPreferences().compact === true)
  const [alignChoices, setAlignChoices] = useState<Record<string, ColumnAlign>>(() => readPreferences().align ?? {})
  // The identifying column (the row's name) stays in view by default.
  const [frozen, setFrozenState] = useState(() => readPreferences().frozen ?? 1)
  // Folded board columns are saved with the same list view preferences as the chosen view.
  const [collapsedColumns, setCollapsedColumns] = useState<Set<string>>(() => new Set(readPreferences().collapsedColumns ?? []))
  const toggleColumn = (key: string) => {
    const next = new Set(collapsedColumns)
    if (!next.delete(key)) next.add(key)
    setCollapsedColumns(next)
    persistPreferences({collapsedColumns: [...next]})
  }
  const widthFor = (field: FieldDescriptor) => columnWidths[field.id] ?? field.width ?? (field.kind === 'thumbnail' ? 76 : 180)
  const updateColumnWidth = (field: FieldDescriptor, width: number) => {
    const nextWidth = Math.max(64, Math.min(720, Math.round(width)))
    setColumnWidths(current => ({...current, [field.id]: nextWidth}))
  }
  // Every writer passes only what it changed; the rest is read from state.
  const persistPreferences = (changed: ViewPreferences) => {
    // Local changes and applied aspects are protected while an account's
    // preferences hydrate. Other aspects must still receive that late read.
    if ('order' in changed || 'hidden' in changed) protectedConfigurationAspects.current.add('columns')
    if ('groupLevels' in changed) protectedConfigurationAspects.current.add('groups')
    if (['view', 'columnWidths', 'compact', 'align', 'frozen', 'detail', 'displaySettings', 'collapsedColumns'].some(key => key in changed)) protectedConfigurationAspects.current.add('display')
    const next: ViewPreferences = {...readPreferences(), columnWidths, compact: compactRows, ...(ownOrder ? {order: ownOrder} : {}), hidden: [...hidden], align: alignChoices, frozen, ...changed}
    try { localStorage.setItem(resolvedPreferenceKey, JSON.stringify(next)) } catch { /* private browsing or a disabled storage surface */ }
    setConfigurationError(null)
    void writeRecordViewPreference(resolvedPreferenceKey, next).catch(error => {
      setConfigurationError(errorWords(error, 'The view preference could not be saved. Try again.'))
    })
  }
  const changeDensity = (compact: boolean) => {
    setCompactRows(compact)
    persistPreferences({compact})
  }
  const setHidden = (next: Set<string>) => {
    setHiddenState(next)
    persistPreferences({hidden: [...next]})
  }
  const setFrozen = (count: number) => {
    setFrozenState(count)
    persistPreferences({frozen: count})
  }
  const setAlign = (field: FieldDescriptor, align: ColumnAlign) => {
    const next = {...alignChoices, [field.id]: align}
    setAlignChoices(next)
    persistPreferences({align: next})
  }
  const resetWidth = (field: FieldDescriptor) => {
    const next = {...columnWidths}
    delete next[field.id]
    setColumnWidths(next)
    persistPreferences({columnWidths: next})
  }

  const byId = useMemo(() => new Map(fields.map(field => [field.id, field])), [fields])
  // One order for every field this surface knows: columns and the facts a
  // person can only filter by. A field added since the order was kept joins
  // at the end; one removed drops out. Neither needs the person to do anything.
  const everyId = useMemo(() => [...new Set([...fields.map(field => field.id), ...(givenRuleFields ?? []).map(field => field.id)])], [fields, givenRuleFields])
  const keptOrder = givenFieldOrder ?? ownOrder ?? readPreferences().order ?? []
  const order = useMemo(() => orderIds(keptOrder, everyId), [keptOrder, everyId])
  const rank = useMemo(() => new Map(order.map((id, at) => [id, at])), [order])
  const byRank = <T extends {id: string}>(list: T[]) => [...list].sort((left, right) => (rank.get(left.id) ?? 0) - (rank.get(right.id) ?? 0))
  const changeOrder = (next: string[]) => {
    const full = orderIds(next, everyId)
    if (onFieldOrderChange) onFieldOrderChange(full)
    else { setOwnOrder(full); persistPreferences({order: full}) }
  }
  /** Move a sublist (the rows one menu showed) into the full order, keeping
   *  every field that menu did not show where it was. */
  const reorderWithin = (shownIds: string[]) => {
    const slots = order.map((id, at) => (shownIds.includes(id) ? at : -1)).filter(at => at >= 0)
    const next = [...order]
    slots.forEach((slot, index) => { next[slot] = shownIds[index] })
    changeOrder(next)
  }
  const ordered = useMemo(() => order.filter(id => byId.has(id)).map(id => byId.get(id)!), [order, byId])

  const groupable = ordered.filter(field => field.groupable)
  const [ownLevels, setOwnLevels] = useState<GroupLevel[]>(() => (initialIncludes('groups') ? initialSaved?.groups : undefined) ?? readPreferences().groupLevels ?? defaultGroupLevels ?? [])
  const levels = (givenLevels ?? ownLevels).filter(level => byId.get(level.field)?.groupable)
  const changeLevels = (next: GroupLevel[]) => {
    if (!givenLevels) setOwnLevels(next)
    onGroupLevelsChange?.(next)
    if (!givenLevels) persistPreferences({groupLevels: next})
  }
  useEffect(() => {
    if (!accountPreferences) return
    const protectedAspects = protectedConfigurationAspects.current
    if (!protectedAspects.has('columns')) {
      if (givenFieldOrder === undefined) setOwnOrder(accountPreferences.order ?? null)
      setHiddenState(new Set(accountPreferences.hidden ?? fields.filter(field => field.hiddenByDefault).map(field => field.id)))
    }
    if (!protectedAspects.has('groups') && givenLevels === undefined) setOwnLevels(accountPreferences.groupLevels ?? defaultGroupLevels ?? [])
    if (!protectedAspects.has('display')) {
      if (accountPreferences.view && views.some(option => option.id === accountPreferences.view)) setView(accountPreferences.view)
      setColumnWidths(accountPreferences.columnWidths ?? {})
      setCompactRows(accountPreferences.compact === true)
      setAlignChoices(accountPreferences.align ?? {})
      setFrozenState(accountPreferences.frozen ?? 1)
      setCollapsedColumns(new Set(accountPreferences.collapsedColumns ?? []))
      setViewSettings(accountPreferences.displaySettings ?? {})
      setDetailId(accountPreferences.detail)
    }
  }, [accountPreferences, resolvedPreferenceKey])
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const toggleSection = (key: string) => setCollapsed(current => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })

  const shown = ordered.filter(field => !hidden.has(field.id))
  // Twenty pins the identifying field: it is the row's name, so it cannot be
  // hidden or dragged away from the front.
  const identifying = shown[0]
  // What a record is CALLED, which is not always the first column: a media
  // surface leads with a picture. An image has no words in it, so naming a row
  // by its first column would announce a file path to anyone listening.
  const naming = shown.find(field => field.kind !== 'thumbnail') ?? identifying
  const nameOf = (record: any) => asText(readField(naming, record)) || 'this record'
  // What each record is for the menus: the caller's own answer, else the record its share reference names.
  const aboutOf = (record: any): MenuThing | undefined => {
    const own = aboutRecord?.(record)
    if (own) return own
    const ref = shareRecord?.(record)
    return ref ? {kind: 'record', id: ref, title: nameOf(record), record: ref} : undefined
  }
  // A row has a ⋯ when it has its own actions or says what it is, since the menus then offer every row for that thing.
  const rowMenu = rowActions.length > 0 || Boolean(aboutRecord || shareRecord)
  const marked = useMemo(() => [...fields.filter(field => field.preview), ...previewFields], [fields, previewFields])
  // A caller that marks nothing for the preview still gets one: the record's
  // own shown fields after its name, the same card every view opens.
  const previewing = useMemo(() => {
    const ordered = [...marked, ...shown.filter(field => field !== naming && field.kind !== 'thumbnail')]
    return ordered.filter((field, index) => ordered.findIndex(other => other.id === field.id) === index)
  }, [marked, shown, naming])
  // Whether a column holds numbers, read from the first record that has a
  // value in it: numbers sit right so their digits line up. A date is a
  // moment, not an amount, and keeps to the left.
  const numeric = useMemo(() => {
    const cache = new Map<string, boolean>()
    return (field: FieldDescriptor) => {
      if (!cache.has(field.id)) {
        const first = isDateField(field) ? undefined : records.map(record => factOf(field, field.id, record)).find(value => value !== null && value !== undefined && value !== '')
        cache.set(field.id, typeof first === 'number')
      }
      return cache.get(field.id)!
    }
  }, [records])
  const alignFor = (field: FieldDescriptor): ColumnAlign => alignChoices[field.id] ?? field.align ?? (numeric(field) ? 'right' : 'left')

  // What a person can filter by: the caller's facts, or the filterable columns.
  const ruleFields = useMemo<RuleFieldView[]>(() => byRank(givenRuleFields ?? fields
    .filter(field => field.filterable && field.ruleKind)
    .map(field => ({id: field.id, label: field.label, kind: field.ruleKind!, unit: field.unit, icon: field.icon, values: field.values, pickValues: field.pickValues}))), [givenRuleFields, fields, rank])
  const factFields = useMemo(() => [
    ...ruleFields.map(ruleField => {
      const field = byId.get(ruleField.id)
      return {id: ruleField.id, kind: ruleField.kind, value: (record: any) => factOf(field, ruleField.id, record)}
    }),
    // A field that answers for a shared scope is also readable under that name,
    // so a focus set on the scope reaches it. A scope's fact is always the list
    // of values the record holds (one pursuit or several), so one focus rule
    // reads every list alike.
    ...fields.filter(field => field.scope && !ruleFields.some(ruleField => ruleField.id === field.scope))
      .map(field => ({id: field.scope!, kind: 'tags', value: (record: any) => asList(readField(field, record)).filter(Boolean)})),
  ], [ruleFields, fields, byId])
  // Every level above this list, ANDed root first; a level whose rule reads a
  // fact this list does not hold leaves its records alone and says so.
  const inherited = useMemo(() => effectiveRule(chainPath.slice(0, -1), storedRules, {
    all: ruleOperators ? allOf(ruleOperators) : 'and',
    canRead: fieldId => Boolean(loadFilterRecords) && factFields.some(field => field.id === fieldId),
  }), [chainPath, storedRules, ruleOperators, loadFilterRecords, factFields])
  const chainRule = useMemo<RuleGroup>(() => inherited.applied.length
    ? {...inherited.rule, rules: [...inherited.rule.rules, rules]}
    : rules, [inherited, rules])
  // The filter is fetched the first time a rule is in force; until it arrives
  // the list keeps showing its records.
  const [filterRecords, setFilterRecords] = useState<FilterRecords | null>(null)
  const [filterError, setFilterError] = useState(false)
  const ruleInForce = countRules(chainRule) > 0
  useEffect(() => {
    if (!ruleInForce || filterRecords || filterError || !loadFilterRecords) return
    let current = true
    loadFilterRecords().then(loaded => { if (current) setFilterRecords(() => loaded) }, () => { if (current) setFilterError(true) })
    return () => { current = false }
  }, [ruleInForce, filterRecords, filterError, loadFilterRecords])
  const facets = useMemo(() => ruleFacets ?? localFacets(ruleFields, records, (id, record) => factFields.find(field => field.id === id)?.value(record)), [ruleFacets, ruleFields, records, factFields])

  const needsConfigurationProjection = Boolean(configurationTime || secondarySort.length)
  const filteredRecords = useMemo(() => {
    // A filter is a constraint, including while its evaluator loads. Never briefly
    // paint unfiltered records under a selected view or app-wide focus.
    if (ruleInForce && !filterRecords) return []
    let rows = records
    const query = callerSearch ? '' : search.trim().toLowerCase()
    if (query) rows = rows.filter(record => fields.some(field => asText(readField(field, record)).toLowerCase().includes(query)))
    if (filterRecords && ruleInForce) rows = filterRecords(rows, chainRule, factFields)
    if (sort && !needsConfigurationProjection) {
      const field = byId.get(sort.fieldId)
      if (field) {
        const direction = sort.direction === 'asc' ? 1 : -1
        rows = [...rows].sort((left, right) => {
          if (field.sortValue) {
            const a = field.sortValue(left), b = field.sortValue(right)
            if (typeof a === 'number' && typeof b === 'number') return (a - b) * direction
            return asText(a).localeCompare(asText(b), undefined, {numeric: true}) * direction
          }
          return asText(readField(field, left)).localeCompare(asText(readField(field, right)), undefined, {numeric: true}) * direction
        })
      }
    }
    return rows
  }, [records, fields, byId, search, chainRule, ruleInForce, sort, filterRecords, factFields, callerSearch, needsConfigurationProjection])
  // The saved-view engine owns time bounds and multiple sort keys everywhere.
  // It receives the records already narrowed by the surface's search and rule
  // tree, so a formula never bypasses the caller's filtering or record access.
  const [configurationClock, setConfigurationClock] = useState(() => Date.now())
  const rollingTime = Boolean(configurationTime?.after?.binding || configurationTime?.before?.binding || levels.some(level => level.bucket === 'relative'))
  useEffect(() => {
    if (!rollingTime || configurationContext?.now !== undefined) return
    setConfigurationClock(Date.now())
    const timer = window.setInterval(() => setConfigurationClock(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [rollingTime, configurationContext?.now])
  const [projectionRetry, setProjectionRetry] = useState(0)
  const projectionInput = useMemo(() => needsConfigurationProjection ? {
    view: {label, search: '', time: configurationTime, time_zone: configurationTimeZone,
      sort: sort ? [{field: sort.fieldId, direction: sort.direction}, ...secondarySort] : []},
    fields: fields.map(field => ({id: field.id, kind: field.ruleKind ?? field.kind ?? 'text'})),
    rows: filteredRecords.map(record => ({id: identify(record), record,
      values: Object.fromEntries(fields.map(field => [field.id, field.sortValue ? field.sortValue(record) : factOf(field, field.id, record)]))})),
    now: configurationContext?.now ?? configurationClock,
    resolveTimeBound: configurationContext?.resolveTimeBound,
  } : null, [needsConfigurationProjection, filteredRecords, fields, identify, label, configurationTime, configurationTimeZone, sort, secondarySort,
    configurationContext?.now, configurationContext?.resolveTimeBound, configurationClock, projectionRetry])
  const [projection, setProjection] = useState<{input: typeof projectionInput; records: any[]; error?: string} | null>(null)
  useEffect(() => {
    if (!projectionInput) return
    let current = true
    projectSavedView(projectionInput).then(result => {
      if (current) setProjection({input: projectionInput, records: result.rows.map(row => row.record)})
    }, error => {
        if (current) setProjection({input: projectionInput, records: [], error: errorWords(error, 'This time range could not be applied.')})
    })
    return () => {current = false}
  }, [projectionInput])
  const projectionPending = Boolean(projectionInput && projection?.input !== projectionInput)
  const projectionError = projectionInput && projection?.input === projectionInput ? projection.error : undefined
  const projectedVisible = projectionInput ? projection?.input === projectionInput ? projection.records : [] : filteredRecords
  const visibleCriteria = JSON.stringify({search: callerSearch?.value ?? search, rules: chainRule,
    time: configurationTime, zone: configurationTimeZone, sort, secondarySort})
  const lastVisible = useRef<{criteria: string; ids: string[]} | null>(null)
  const readingValues = derivedProjectionPending || derivedProjectionError || projectionPending || Boolean(projectionError)
  // Refreshing calculations must not unmount an editor and discard its refused
  // draft. Retain only identities still supplied by the current owner, under
  // unchanged filters, while the status above the rows says what is pending.
  const visible = useMemo(() => {
    if (!readingValues || lastVisible.current?.criteria !== visibleCriteria) return projectedVisible
    const current = new Map(records.map(record => [identify(record), record]))
    return lastVisible.current.ids.flatMap(id => current.has(id) ? [current.get(id)] : [])
  }, [readingValues, visibleCriteria, projectedVisible, records, identify])
  useEffect(() => {
    if (!readingValues) lastVisible.current = {criteria: visibleCriteria, ids: projectedVisible.map(identify)}
  }, [readingValues, visibleCriteria, projectedVisible, identify])
  // The title's count: every record there is while the page in hand is shown whole, else what is shown.
  const titleCount = total !== undefined && visible.length === records.length ? Math.max(total, visible.length) : visible.length

  // The caller's next page is asked for when a zero-height marker after the drawn records comes within a screen of
  // the scroller's bottom, or while what is shown is decided over every record (onReadMore).
  const endMarker = useRef<HTMLSpanElement | null>(null)
  const [endNear, setEndNear] = useState(false)
  const readsMore = Boolean(onReadMore)
  // Select all over a caller that reads more selects every record: the rest are read (`every`) and each page is selected
  // as it arrives, until every record is read or the selection is changed another way.
  const [selectingEvery, setSelectingEvery] = useState(false)
  useEffect(() => {
    const marker = endMarker.current
    if (!readsMore || !marker || typeof IntersectionObserver === 'undefined') return
    const scroller = scrollerOf(marker)
    const observer = new IntersectionObserver(([entry]) => setEndNear(entry.isIntersecting), {root: scroller === document.scrollingElement ? null : scroller, rootMargin: '0px 0px 100% 0px'})
    observer.observe(marker)
    return () => observer.disconnect()
  }, [readsMore])
  const searching = Boolean((callerSearch?.value ?? search).trim())
  const ordering = selectingEvery || Boolean(sort) || secondarySort.length > 0 || levels.length > 0 || Boolean(configurationTime)
  useEffect(() => {
    if (onReadMore && (endNear || searching || ruleInForce || ordering)) onReadMore({end: endNear, search: searching, rules: ruleInForce, every: ordering})
  }, [onReadMore, endNear, searching, ruleInForce, ordering, records])

  // How many records hold each value, counted once per field for the records
  // in hand, never once per drawn tag: a tag on every visible row that walks
  // every record is rows × records work on each frame.
  const countOf = useMemo<CountOf>(() => {
    const counted = new Map<string, Map<string, number>>()
    return (field, value) => {
      if (field.countValue) return field.countValue(records, value)
      let counts = counted.get(field.id)
      if (!counts) {
        counts = new Map()
        for (const record of records) for (const each of new Set(asList(readField(field, record)))) counts.set(each, (counts.get(each) ?? 0) + 1)
        counted.set(field.id, counts)
      }
      return counts.get(value) ?? 0
    }
  }, [records])

  const groupField = levels.length ? byId.get(levels[0].field) : undefined
  // Board columns always need a field; with grouping off they use the first groupable one.
  const boardField = groupField ?? (view === 'board' ? groupable[0] : undefined)
  const selectedIds = [...selected]
  // A record's hover preview, the same in every view. The content is the first
  // `media` field the caller marks for the preview; hovering one of several
  // selected records shows every selected record in view order as a carousel,
  // starting at the hovered one. With nothing marked, the element stands alone.
  const previewContent = previewing.find(field => field.kind === 'media')
  const [editingCells, setEditingCells] = useState<ReadonlySet<string>>(() => new Set())
  const cellEditing = useCallback((recordId: string, fieldId: string, editing: boolean) => {
    const key = JSON.stringify([recordId, fieldId])
    setEditingCells(current => {
      if (current.has(key) === editing) return current
      const next = new Set(current)
      if (editing) next.add(key); else next.delete(key)
      return next
    })
  }, [])
  const withPreview = (trigger: React.ReactElement<Record<string, unknown>>, record: any, id: string, side?: 'right' | 'bottom') => {
    if (!previewing.length && !rowActions.length) return trigger
    const group = selected.size > 1 && selected.has(id) ? visible.filter(one => selected.has(identify(one))) : [record]
    // A record with no content to show and nothing else marked for the
    // preview (a folder among files) keeps its plain row: a card holding only
    // its name would repeat what the row already says.
    if (group.length === 1 && previewContent && !previewing.some(field => field.kind !== 'media') && !previewItemOf(readField(previewContent, record), id)) return trigger
    return (
      <HoverPreview
        key={trigger.key ?? id}
        control={CARD_CONTROLS.list}
        trigger={trigger}
        disabled={fields.some(field => editingCells.has(JSON.stringify([id, field.id])))}
        side={side}
        items={group}
        start={Math.max(0, group.findIndex(one => identify(one) === id))}
        label={group.length > 1 ? `${group.length} selected` : nameOf(record)}
        preview={one => previewContent ? previewItemOf(readField(previewContent, one), identify(one)) : null}
        renderPreview={renderPreview}
        details={one => <RecordPreviewDetails record={one} recordId={identify(one)} name={nameOf(one)} fields={previewing} actions={rowActions} about={aboutOf(one)} onOpen={onOpen}/>}
      />
    )
  }

  // The run of records cut into nested, labelled sections, preserving the
  // order they arrived in so a sort still decides the sequence and sections
  // only describe it. Without a grouping, the caller's divider field (if any)
  // cuts one level; with neither, one run and no headings.
  const sectionLevels = useMemo(() => levels.length ? levels : groupDividerBy && byId.has(groupDividerBy) ? [{field: groupDividerBy}] : [], [levels, groupDividerBy, byId])
  const sectionTree = useMemo(() => buildSections(visible, {
    levels: sectionLevels,
    timeZone: configurationTimeZone,
    now: configurationContext?.now ?? configurationClock,
    fieldOf: id => byId.get(id),
    valuesOf: (field, record) => groupingValues(field as FieldDescriptor, record, configurationTimeZone),
    isDate: field => isDateField(field as FieldDescriptor),
    compare: field => groupComparator(field as FieldDescriptor),
    readable: (field, value) => groupingLabel(field as FieldDescriptor, value),
  }), [visible, sectionLevels, byId, configurationTimeZone, configurationContext?.now, configurationClock])
  const blocks = useMemo(() => sectionTree.length
    ? flattenSections(sectionTree, collapsed)
    : [{kind: 'records' as const, key: 'all', depth: 0, records: visible}], [sectionTree, collapsed, visible])
  // The gallery as a timeline: while no grouping is chosen, the dated field
  // the caller names cuts the run into the calendar stretches of the current
  // zoom level. Records keep their order; stretches only describe it.
  const timelineLevels = timeline?.levels
  const [ownLevelId, setOwnLevelId] = useState<string | undefined>(timeline?.level)
  // `level` supplies the initial level and may also be updated by a caller.
  // Once the person zooms, the local choice must win while the prop remains
  // unchanged; otherwise a static starting value snaps every press back.
  const previousTimelineLevel = useRef(timeline?.level)
  useEffect(() => {
    if (timeline?.level !== previousTimelineLevel.current) {
      previousTimelineLevel.current = timeline?.level
      setOwnLevelId(timeline?.level)
    }
  }, [timeline?.level])
  const levelAt = timelineLevels ? levelIndex(timelineLevels, ownLevelId ?? timeline?.level) : -1
  const zoomLevel = timelineLevels && levelAt >= 0 ? timelineLevels.levels[levelAt] : undefined
  const timelineActive = view === 'gallery' && !!zoomLevel && !levels.length
  const timelineField = timeline ? byId.get(timeline.fieldId) : undefined
  // How much each card says: one of the detail levels, kept with the list's other view choices. A gallery that is a
  // timeline zooms through its calendar levels instead.
  const [detailId, setDetailId] = useState<string | undefined>(() => readPreferences().detail)
  const detailAt = detailLevels ? Math.max(0, detailLevels.levels.findIndex(level => level.id === (detailId ?? detailLevels.default_level))) : -1
  const detailLevel = detailLevels && detailAt >= 0 ? detailLevels.levels[detailAt] : undefined
  // A view another part draws for this list (the visual-database outline, tree, timeline and the rest) moves through the
  // same steps, handed to it as `detail`.
  const callerDraws = Boolean(callerView?.render && !callerView.mount)
  const detailActive = !!detailLevel && (view === 'board' || (view === 'gallery' && !timelineActive) || callerDraws)
  const cardDetail = detailActive ? detailLevel : undefined
  const timelineBlocks = useMemo<SectionBlock[] | null>(() => {
    if (!timelineActive || !zoomLevel || !timelineLevels) return null
    const timeOf = (record: any): number | null => {
      if (!timelineField) return null
      const raw = timelineField.sortValue ? timelineField.sortValue(record) : factOf(timelineField, timelineField.id, record)
      const time = typeof raw === 'number' ? raw : Date.parse(asText(raw))
      return Number.isFinite(time) && time > 0 ? time : null
    }
    const stretches = new Map<string, {label: string; records: any[]}>()
    for (const record of visible) {
      const bucket = bucketFor(timeOf(record), zoomLevel, timelineLevels.undated_heading)
      let stretch = stretches.get(bucket.key)
      if (!stretch) { stretch = {label: bucket.label, records: []}; stretches.set(bucket.key, stretch) }
      stretch.records.push(record)
    }
    const out: SectionBlock[] = []
    for (const [value, stretch] of stretches) {
      // A timeline heading names its stretch; `fieldId` is left empty so no
      // field's own group renderer is handed a bucket key it never made.
      const node: SectionNode = {key: `timeline/${zoomLevel.id}/${value}`, value, label: stretch.label, fieldId: '', depth: 0, count: stretch.records.length, records: stretch.records, children: []}
      const closed = collapsed.has(node.key)
      out.push({kind: 'heading', node, collapsed: closed})
      if (!closed) out.push({kind: 'records', key: `${node.key}#records`, depth: 1, records: stretch.records})
    }
    return out
  }, [timelineActive, zoomLevel, timelineLevels, timelineField, visible, collapsed])
  const drawnBlocks = timelineBlocks ?? blocks

  // A group a person chose says which field it groups by ("Kind: Key"); the
  // caller's own divider (a file list's days) and a timeline's stretches are
  // already plain words and read as they are.
  const groupedBy = (node: SectionNode) => levels.some(level => level.field === node.fieldId) ? byId.get(node.fieldId) : undefined
  const headingName = (node: SectionNode) => {
    const field = groupedBy(node)
    return field ? `${field.label}: ${node.label}` : node.label
  }
  const headingContent = (node: SectionNode) => {
    const field = byId.get(node.fieldId)
    if (node.value && field?.renderGroup) return field.renderGroup(node.value, recordsIn(node))
    const by = groupedBy(node)
    return by ? <><span className="record-views-group-field">{by.label}:</span> {node.label}</> : node.label
  }
  // A group heading is the shared folding heading (the sidebar's lists use the
  // same one): the whole row folds the group, the count is a chip, and
  // hovering it summarizes what is actually inside.
  const sectionHeading = (node: SectionNode, closed: boolean) => (
    <DisclosureHeading
      className="record-views-divider"
      label={headingContent(node)}
      accessibleLabel={headingName(node)}
      open={!closed}
      onOpenChange={() => toggleSection(node.key)}
      count={node.count}
      depth={node.depth}
      wrap={toggle => <GroupSummary trigger={toggle} node={node} fields={ordered} name={nameOf} timeZone={configurationTimeZone}/>}
    />
  )

  const changeView = useCallback((next: string) => {
    setView(next)
    onViewChange?.(next)
    persistPreferences({view: next})
  }, [onViewChange, persistPreferences])

  const changeSelection = useCallback((next: Set<string>) => {
    setSelected(next)
    setSelectingEvery(false)
    setAskingId(null)
    onSelectionChange?.([...next])
  }, [onSelectionChange])
  useEffect(() => {
    if (!selectingEvery) return
    const every = new Set(visible.map(identify))
    setSelected(every)
    onSelectionChange?.([...every])
    if (!readsMore) setSelectingEvery(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- identify and onSelectionChange are given anew on each update
  }, [selectingEvery, visible, readsMore])

  // Board columns are derived once so the drawn board and the order a
  // shift-pick walks can never disagree.
  const boardColumns = useMemo(() => boardField
    ? buildSections(visible, {
        levels: [{field: boardField.id, bucket: levels[0]?.field === boardField.id ? levels[0].bucket : undefined}],
        timeZone: configurationTimeZone,
        now: configurationContext?.now ?? configurationClock,
        fieldOf: id => byId.get(id),
        valuesOf: (field, record) => groupingValues(field as FieldDescriptor, record, configurationTimeZone),
        isDate: field => isDateField(field as FieldDescriptor),
        compare: field => groupComparator(field as FieldDescriptor),
        readable: (field, value) => groupingLabel(field as FieldDescriptor, value),
      }).map(node => ({value: node.value, label: node.label, range: node.range, records: recordsIn(node)}))
    : [], [boardField, visible, levels, byId, configurationTimeZone, configurationContext?.now, configurationClock])

  // The order records are DRAWN in, after sort, filter and grouping, which is
  // the only order a person can mean when they shift-click from one to another.
  const orderedIds = useMemo(() => {
    const drawn = view === 'board' ? boardColumns.flatMap(column => column.records) : view === 'sheet' ? visible : drawnBlocks.flatMap(block => block.kind === 'records' ? block.records : [])
    return [...new Set(drawn.map(identify))]
  }, [view, boardColumns, drawnBlocks, visible, identify])


  // Where the last deliberate pick happened (the fixed end of a range) and
  // where the moving end currently sits, so shift-click and shift-arrow both
  // stretch from the same place, the way every file browser does.
  const anchor = useRef<string | null>(null)
  const lead = useRef<string | null>(null)

  const rangeTo = (id: string, additive: boolean) => {
    const from = orderedIds.indexOf(anchor.current ?? id)
    const to = orderedIds.indexOf(id)
    if (from < 0 || to < 0) return false
    const next = additive ? new Set(selected) : new Set<string>()
    for (const each of orderedIds.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(each)
    lead.current = id
    changeSelection(next)
    return true
  }

  // One rule for every pick, whatever drew the record:
  //   plain      only this one, and it becomes the anchor
  //   toggle     flip this one, and it becomes the anchor
  //   shift      the stretch from the anchor to here (replacing, or adding when toggle is also held)
  const pick = (id: string, modifiers: {shift?: boolean; toggle?: boolean} = {}) => {
    if (modifiers.shift && anchor.current && rangeTo(id, !!modifiers.toggle)) return
    const next = modifiers.toggle ? new Set(selected) : new Set<string>()
    if (modifiers.toggle && selected.has(id)) next.delete(id)
    else next.add(id)
    anchor.current = id
    lead.current = id
    changeSelection(next)
  }

  // A checkbox always adds or removes; with shift it adds the whole stretch
  // from the anchor, the way a mail inbox's checkboxes behave.
  const toggleOne = (id: string, wanted: boolean, event?: Event) => {
    if (wanted && (event as MouseEvent | undefined)?.shiftKey && anchor.current && rangeTo(id, true)) return
    if (wanted === selected.has(id)) return
    pick(id, {toggle: true})
  }

  // The first click of a double-click collapses a multi-selection to one
  // record; the second click restores it so opening acts on the whole group.
  const beforeCollapse = useRef<{id: string; ids: Set<string>} | null>(null)
  const pressItem = (event: React.MouseEvent, id: string) => {
    if ((event.target as HTMLElement).closest(CONTROLS)) return
    if (event.detail > 1) return
    const toggle = event.metaKey || event.ctrlKey
    beforeCollapse.current = !toggle && !event.shiftKey && selected.has(id) && selected.size > 1 ? {id, ids: new Set(selected)} : null
    pick(id, {shift: event.shiftKey, toggle})
  }
  const openItem = (event: React.MouseEvent, id: string) => {
    if ((event.target as HTMLElement).closest(CONTROLS)) return
    if (beforeCollapse.current?.id === id) changeSelection(beforeCollapse.current.ids)
    beforeCollapse.current = null
    onOpen?.(id)
  }
  // Holding shift while pressing would otherwise paint a text selection across
  // everything between the two records.
  const noTextRange = (event: React.MouseEvent) => {if (event.shiftKey) event.preventDefault()}
  const pointerFor = (id: string) => ({
    onClick: (event: React.MouseEvent) => pressItem(event, id),
    onDoubleClick: (event: React.MouseEvent) => openItem(event, id),
    onMouseDown: noTextRange,
  })

  // Keys act on the records only while the surface holds focus, and never
  // while a person is typing into a field.
  const keyDown = (event: React.KeyboardEvent) => {
    const target = event.target as HTMLElement
    if (target.closest('input, textarea, select, [contenteditable="true"], [role="menu"], [role="listbox"], [role="dialog"]')) return
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      changeSelection(new Set(orderedIds))
      return
    }
    if (event.key === 'Escape' && selected.size) {
      event.preventDefault()
      beforeCollapse.current = null
      changeSelection(new Set())
      return
    }
    if (view === 'table' && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && orderedIds.length) {
      event.preventDefault()
      const at = orderedIds.indexOf(lead.current ?? anchor.current ?? '')
      const step = event.key === 'ArrowDown' ? 1 : -1
      const next = orderedIds[at < 0 ? (step > 0 ? 0 : orderedIds.length - 1) : Math.min(orderedIds.length - 1, Math.max(0, at + step))]!
      if (event.shiftKey && anchor.current) rangeTo(next, false)
      else pick(next)
      scrollToRecord(next, 'nearest')
    }
  }

  const dragFor = (id: string) => onDragOut || shareRecord
    ? {draggable: true, onDragStart: (event: React.DragEvent) => {
        const ids = selected.has(id) ? [...selected] : [id]
        onDragOut?.(ids, event)
        if (!shareRecord) return
        const rows = new Map(records.map(record => [identify(record), record]))
        const picked = ids.flatMap(recordId => {
          const record = rows.get(recordId)
          const share = record && shareRecord(record)
          return share ? [{id: recordId, record: share, title: nameOf(record)}] : []
        })
        if (!picked.length) return
        const source = event.currentTarget as Element
        const screen = source.closest('[data-trillion-screen]')?.getAttribute('data-trillion-screen') || undefined
        const place = source.closest('[data-trillion-opened-kind][data-trillion-opened-id]')
        const kind = place?.getAttribute('data-trillion-opened-kind')
        const placeId = place?.getAttribute('data-trillion-opened-id')
        setSelectedRecordDragData(event.dataTransfer, {
          records: picked,
          ...(screen ? {screen} : {}),
          ...(kind && placeId ? {context: {kind, id: placeId}} : {}),
        })
      }}
    : {}
  const contextFor = (event: React.MouseEvent, id: string) => {
    if (!onRowContextMenu) return
    // The record's own menu answers this right-click; the pane around it must not open its menu on top.
    event.preventDefault()
    event.stopPropagation()
    const next = selected.has(id) ? selected : new Set([id])
    if (next !== selected) changeSelection(next)
    onRowContextMenu([...next], {x: event.clientX, y: event.clientY})
  }

  // One writer for the rules, so the caller hears about every change through
  // the same door however it was made: the builder, a chip, a column menu or
  // a tag in a cell.
  const changeRules = (next: RuleGroup) => {
    setOwnRules(next)
    if (!controlledRules) nodeRules.write(ownNode, next)
    onQueryChange?.({search, rules: next})
  }

  const changeSearch = (next: string) => {
    setSearch(next)
    onQueryChange?.({search: next, rules})
  }

  const addFilter = (field: FieldDescriptor) => {
    if (!ruleOperators || !field.ruleKind) return
    changeRules(appendAt(rules, [], newRule(ruleOperators, {id: field.id, kind: field.ruleKind})))
  }

  // A date section (a day, a week, "Yesterday") is a span of time, which a
  // rule holds as a range; every other group or tag is one value among several.
  const rangeRuleAt = (field: FieldDescriptor, value: string, span?: {min: number; max: number}) => {
    const range = span ?? (isDateField(field) ? dayRange(value, configurationTimeZone) : null)
    const operator = range && ruleOperators ? operatorsFor(ruleOperators, field.ruleKind).find(candidate => candidate.input === 'range') : undefined
    if (!range || !operator) return null
    const index = rules.rules.findIndex(node => !isGroup(node) && node.field === field.id && node.operator === operator.id && node.params.min === range.min && node.params.max === range.max)
    return {range, operator, index}
  }
  const tagActive = (field: FieldDescriptor, value: string, span?: {min: number; max: number}) => {
    const ranged = rangeRuleAt(field, value, span)
    return ranged ? ranged.index >= 0 : holdsValue(rules, field.id, value)
  }
  const filterByTag = (field: FieldDescriptor, value: string, span?: {min: number; max: number}) => {
    if (!field.filterable || !ruleOperators || !field.ruleKind) return
    const ranged = rangeRuleAt(field, value, span)
    if (!ranged) return changeRules(toggleValue(rules, ruleOperators, {id: field.id, kind: field.ruleKind}, value))
    changeRules(ranged.index >= 0 ? replaceAt(rules, [ranged.index], null) : appendAt(rules, [], {kind: 'rule', field: field.id, operator: ranged.operator.id, params: {...ranged.range}}))
  }

  // Named configurations hold the live settings of this surface. The shared
  // aspect engine captures and applies the same data for people and AI tools;
  // switching a partial configuration leaves every unselected aspect alone.
  const [savingDesign, setSavingDesign] = useState(false)
  const designedNow = views.find(option => option.id === view)?.designed
  const activeSaved = savedViews.find(candidate => candidate.id === activeSavedId)
  const canUpdateConfiguration = Boolean(activeSaved && !activeSaved.readOnly && onUpdateSavedView)
  const [viewSettings, setViewSettings] = useState<Record<string, Record<string, unknown>>>(() => readPreferences().displaySettings ?? {})
  const settingsOfView = viewSettings[view]
  const currentSettings = () => ({
    search: callerSearch ? draft : search, rules,
    time_zone: configurationTimeZone,
    sort: sort ? [{field: sort.fieldId, direction: sort.direction}, ...secondarySort] : [],
    groups: levels.map(level => ({field: level.field, ...(level.bucket === undefined ? {} : {bucket: level.bucket})})),
    columns: {order, hidden: [...hidden]},
    time: configurationTime,
    display: {as: view, settings: settingsOfView ?? {}, surface: {
      columnWidths: Object.fromEntries(Object.entries(columnWidths).filter(([id]) => byId.has(id))),
      compact: compactRows,
      align: Object.fromEntries(Object.entries(alignChoices).filter(([id]) => byId.has(id))),
      frozen: Math.min(frozen, fields.length), detail: detailLevel?.id ?? null, timeline: zoomLevel?.id ?? null,
    }},
  })
  const currentViewRow = (label: string, aspects?: string[]): Omit<SavedRecordView, 'id'> => ({
    label,
    ...captureConfigurationSettings(currentSettings(), undefined, everyId) as Omit<SavedRecordView, 'id' | 'label'>,
    aspects: selectedConfigurationAspects(aspects),
  })
  // The editor closes only after its caller confirms the write. A rejected
  // save retains its name, selection and retry path instead of looking saved.
  const runConfigurationAction = async (work: () => void | Promise<void>) => {
    if (configurationPending.current) return false
    configurationPending.current = true
    setConfigurationBusy(true)
    setConfigurationError(null)
    try { await work(); return true }
    catch (error) { setConfigurationError(errorWords(error, 'The configuration could not be saved. Try again.')); return false }
    finally { configurationPending.current = false; setConfigurationBusy(false) }
  }
  const saveSettingsOfView = (next: Record<string, unknown>) => {
    const changed = {...viewSettings, [view]: next}
    setViewSettings(changed)
    if (activeSaved && canUpdateConfiguration && (activeSaved.aspects === undefined || activeSaved.aspects.includes('display'))) {
      void runConfigurationAction(() => onUpdateSavedView!({id: activeSaved.id, label: activeSaved.label,
        ...(activeSaved.revision === undefined ? {} : {revision: activeSaved.revision}),
        display: {...currentSettings().display, settings: next}}))
    } else persistPreferences({displaySettings: changed})
  }
  const saveView = async () => {
    const label = savedViewName.trim()
    if (!label) return
    const succeeded = await runConfigurationAction(async () => {
      if (savingDesign && designedNow) {
        const {slots: _slots, ...layout} = designedNow
        await writeRecordViewPreference(DESIGNED_VIEWS_PREFERENCE, [...keptRows(keptDesigns), {...layout, id: `${designedNow.design}:${crypto.randomUUID()}`, label}])
      } else if (editingSavedId) {
        const editing = savedViews.find(saved => saved.id === editingSavedId)
        if (!editing || editing.readOnly || !onUpdateSavedView) throw new Error('This configuration is no longer editable.')
        await onUpdateSavedView({id: editingSavedId, label, ...(editing.revision === undefined ? {} : {revision: editing.revision})})
      } else {
        if (!onSaveView) throw new Error('Saving configurations is unavailable here.')
        await onSaveView(currentViewRow(label, savingAspects))
      }
    })
    if (!succeeded) return
    setSavedViewName('')
    setSavingView(false)
    setSavingDesign(false)
    setEditingSavedId(null)
  }

  const applySavedView = (saved: SavedRecordView) => {
    try {
      const selected = new Set(selectedConfigurationAspects(saved.aspects))
      // Metadata never becomes a view setting. Legacy rows may omit an aspect's
      // fields; the shared engine supplies the same explicit defaults as the API.
      const settings = Object.fromEntries(configurationAspects.flatMap(aspect => aspect.fields)
        .filter(key => saved[key as keyof SavedRecordView] !== undefined)
        .map(key => [key, saved[key as keyof SavedRecordView]]))
      const next = applyConfigurationSettings(currentSettings(), {settings, aspects: saved.aspects}, everyId)
      if (selected.has('rules')) {
        setOwnRules(next.rules)
        if (!controlledRules) nodeRules.write(ownNode, next.rules)
      }
      if (selected.has('search')) {
        setSearch(next.search)
        setDraft(next.search)
        if (callerSearch && !onApplySavedView) callerSearch.onCommit(next.search)
      }
      if (selected.has('sort')) {
        setSort(next.sort[0] ? {fieldId: next.sort[0].field, direction: next.sort[0].direction} : null)
        setSecondarySort(next.sort.slice(1))
      }
      if (selected.has('groups')) {
        if (!givenLevels) { setOwnLevels(next.groups) }
        onGroupLevelsChange?.(next.groups)
      }
      if (selected.has('columns')) {
        const full = orderIds(next.columns.order, everyId)
        if (onFieldOrderChange) onFieldOrderChange(full)
        else { setOwnOrder(full) }
        setHiddenState(new Set(next.columns.hidden))
      }
      if (selected.has('time')) {
        setConfigurationTime(next.time)
        setConfigurationTimeZone(next.time_zone)
      }
      if (selected.has('display')) {
        const display = next.display as SavedViewDisplay | null
        if (display?.as && views.some(option => option.id === display.as)) {
          setView(display.as)
          onViewChange?.(display.as)
          setViewSettings(current => ({...current, [display.as]: display.settings ?? {}}))
        } else if (display === null) {
          // An explicit cleared display retains the current layout but clears its
          // extra choices. Old rows without display still use the same layout.
          setViewSettings(current => ({...current, [view]: {}}))
        }
        const surface = display?.surface
        if (surface) {
          if (surface.columnWidths !== undefined) { setColumnWidths(surface.columnWidths) }
          if (surface.compact !== undefined) { setCompactRows(surface.compact) }
          if (surface.align !== undefined) { setAlignChoices(surface.align) }
          if (surface.frozen !== undefined) { setFrozenState(surface.frozen) }
          if (surface.detail !== undefined && (surface.detail === null || detailLevels?.levels.some(level => level.id === surface.detail))) {
            setDetailId(surface.detail ?? undefined)
          }
          if (surface.timeline !== undefined && (surface.timeline === null || timelineLevels?.levels.some(level => level.id === surface.timeline))) {
            setOwnLevelId(surface.timeline ?? undefined)
            if (surface.timeline !== null) timeline?.onLevelChange?.(surface.timeline)
          }
        }
      }
      setActiveSavedId(saved.id)
      for (const aspect of selected) protectedConfigurationAspects.current.add(aspect)
      setConfigurationError(null)
      // The configuration record already persists these settings. Opening it
      // never overwrites the person's still-loading preference record.
      if (onApplySavedView) onApplySavedView({...saved, ...next})
      else onQueryChange?.({search: next.search, rules: next.rules})
    } catch (error) {
      setConfigurationError(errorWords(error, 'This configuration could not be opened.'))
    }
  }
  // A deep link can arrive after the list has mounted, and another link may
  // replace it in the same mounted surface. Apply each request once when its
  // row arrives; re-reading our own save must never reset unrelated local work.
  const requestedConfiguration = useRef<{key: string; applied: boolean} | null>(null)
  useEffect(() => {
    const key = `${resolvedPreferenceKey}\0${initialSavedViewId ?? ''}`
    if (requestedConfiguration.current?.key !== key) requestedConfiguration.current = {key, applied: false}
    if (!initialSavedViewId || requestedConfiguration.current.applied) return
    const arrived = savedViews.find(saved => saved.id === initialSavedViewId)
    if (!arrived) return
    requestedConfiguration.current.applied = true
    applySavedView(arrived)
  }, [resolvedPreferenceKey, initialSavedViewId, savedViews])

  // Drag a rectangle across the records to select what it touches. It works for
  // every view because it asks the drawn elements where they are rather than
  // knowing anything about rows, cards or columns: each carries its id in
  // data-record-id, and that is the whole contract.
  // The same surface ref above also measures the look's arrival duration.
  // The pinned state controls layout and edge fades. Its background is
  // painted by screen-look immediately, before an observer can report pinning.
  // A zero-height marker just above the bar leaves its scroller's top edge
  // exactly when the bar pins.
  const barMarker = useRef<HTMLSpanElement | null>(null)
  const [barPinned, setBarPinned] = useState(false)
  useEffect(() => {
    const marker = barMarker.current
    if (!marker || typeof IntersectionObserver === 'undefined') return
    const scroller = scrollerOf(marker)
    const observer = new IntersectionObserver(([entry]) => setBarPinned(!entry.isIntersecting && entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0)), {root: scroller === document.scrollingElement ? null : scroller})
    observer.observe(marker)
    return () => observer.disconnect()
  }, [])
  // Edge fades, chosen by the current view's DATA. Top and bottom belong to
  // the scroller that holds this surface; while the bar is pinned the fade
  // starts under it, so the bar itself stays solid.
  const fadeEdges = (views.find(option => option.id === view)?.fadeEdges ?? DEFAULT_VIEWS.find(option => option.id === view)?.fadeEdges ?? [])
  const verticalFade = fadeEdges.filter(edge => VERTICAL.includes(edge))
  const sidewaysFade = fadeEdges.filter(edge => !VERTICAL.includes(edge))
  const verticalKey = verticalFade.join(' ')
  useLayoutEffect(() => {
    const marker = barMarker.current
    if (!marker || !verticalKey) return
    const scroller = scrollerOf(marker)
    if (scroller === document.scrollingElement) return
    return watchScrollFade(scroller, verticalKey.split(' ') as ScrollFadeEdge[])
  }, [verticalKey])
  useLayoutEffect(() => {
    const marker = barMarker.current
    const bar = surface.current?.querySelector<HTMLElement>('.record-views-bar')
    if (!marker || !bar || !barPinned) return
    const scroller = scrollerOf(marker)
    if (scroller === document.scrollingElement) return
    scroller.style.setProperty('--scroll-fade-inset-top', `${Math.max(0, bar.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top)}px`)
    return () => scroller.style.removeProperty('--scroll-fade-inset-top')
  }, [barPinned])
  // The bar keeps everything on one line only while its title (name, count and
  // whatever the caller put beside them) shows whole there: a wide view switch
  // or long caller words would otherwise squeeze the title to nothing (Media at
  // a 1110 px bar). Then it takes the two-line layout (data-fit="stacked",
  // record-table.css) until the bar is as wide as the one line needed.
  useLayoutEffect(() => {
    const bar = surface.current?.querySelector<HTMLElement>('.record-views-bar')
    const title = bar?.querySelector<HTMLElement>('.record-views-title')
    if (!bar || !title || typeof ResizeObserver === 'undefined') return
    let neededWidth = 0
    const fit = () => {
      if (bar.dataset.fit === 'stacked') {
        if (bar.clientWidth >= neededWidth) delete bar.dataset.fit
        return
      }
      const short = title.scrollWidth - title.clientWidth
      if (short > 1) {
        neededWidth = bar.clientWidth + short
        bar.dataset.fit = 'stacked'
      }
    }
    const observer = new ResizeObserver(fit)
    observer.observe(bar)
    observer.observe(title)
    return () => observer.disconnect()
  }, [])
  const [marquee, setMarquee] = useState<{left: number; top: number; width: number; height: number} | null>(null)

  useEffect(() => {
    const host = surface.current
    if (!host) return

    let origin: {x: number; y: number} | null = null
    let additive = false
    let onEmpty = false

    const intersecting = (box: {left: number; top: number; right: number; bottom: number}) => {
      const hit: string[] = []
      for (const element of host.querySelectorAll<HTMLElement>('[data-record-id]')) {
        const rect = element.getBoundingClientRect()
        if (rect.right >= box.left && rect.left <= box.right && rect.bottom >= box.top && rect.top <= box.bottom) {
          const id = element.dataset.recordId
          if (id) hit.push(id)
        }
      }
      return hit
    }

    const onPointerDown = (event: PointerEvent) => {
      // Only a plain drag on empty space. A press that landed on a control is
      // that control's press, and dragging a field row is a reorder.
      if (event.button !== 0) return
      const target = event.target as HTMLElement
      if (target.closest(`${CONTROLS}, [draggable="true"]`)) return
      origin = {x: event.clientX, y: event.clientY}
      additive = event.shiftKey || event.metaKey || event.ctrlKey
      onEmpty = !target.closest('[data-record-id]') && !!target.closest('.record-views-scroll, .record-views-gallery-sections, .record-views-board')
    }

    const onPointerMove = (event: PointerEvent) => {
      if (!origin) return
      const left = Math.min(origin.x, event.clientX)
      const top = Math.min(origin.y, event.clientY)
      const width = Math.abs(event.clientX - origin.x)
      const height = Math.abs(event.clientY - origin.y)
      // A few pixels of travel is a click with a shaky hand, not a drag.
      if (width < 4 && height < 4) return
      event.preventDefault()
      setMarquee({left, top, width, height})
    }

    const onPointerUp = (event: PointerEvent) => {
      if (!origin) return
      const started = origin
      origin = null
      const box = {
        left: Math.min(started.x, event.clientX),
        top: Math.min(started.y, event.clientY),
        right: Math.max(started.x, event.clientX),
        bottom: Math.max(started.y, event.clientY),
      }
      const travelled = box.right - box.left >= 4 || box.bottom - box.top >= 4
      setMarquee(null)
      // A plain click on the empty space between records lets go of them.
      if (!travelled) {
        if (onEmpty && !additive && selected.size) changeSelection(new Set())
        return
      }
      const hit = intersecting(box)
      const next = additive ? new Set(selected) : new Set<string>()
      for (const id of hit) next.add(id)
      if (hit.length) anchor.current = lead.current = hit[hit.length - 1]!
      changeSelection(next)
    }

    host.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    return () => {
      host.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
    }
  }, [selected, changeSelection])

  // ---------------------------------------------------------------------------
  // Only what is on screen is drawn. Each view is a column of lines of known
  // height (gallery rows and headings, table rows, board cards); the scroller
  // says which pixels are visible and the lines there are drawn, the rest is
  // spacer. The count, selection, Select all, sort and shift-ranges still see
  // every record, because none of them read the drawn elements.
  const [galleryHost, setGalleryHost] = useState<HTMLDivElement | null>(null)
  const [tableHost, setTableHost] = useState<HTMLDivElement | null>(null)
  const [boardHost, setBoardHost] = useState<HTMLDivElement | null>(null)
  const [callerHost, setCallerHost] = useState<HTMLDivElement | null>(null)
  useScrollFade(view === 'table' ? tableHost : view === 'board' ? boardHost : null, sidewaysFade)
  const galleryWindow = useScrollWindow(view === 'gallery' ? galleryHost : null, 900)
  const tableWindow = useScrollWindow(view === 'table' ? tableHost : null, 900)
  // Gap, inset and the smallest tile outside a timeline are appearance, so
  // they are read from the stylesheet rather than written here.
  const [galleryLook, setGalleryLook] = useState({gap: 8, inset: 8, tile: 200})
  useLayoutEffect(() => {
    if (!galleryHost) return
    const style = getComputedStyle(galleryHost)
    const read = (name: string, fallback: number) => { const value = parseFloat(style.getPropertyValue(name)); return Number.isFinite(value) ? value : fallback }
    const next = {gap: read('--record-views-gallery-gap', 8), inset: read('--record-views-gallery-inset', 8), tile: read('--record-views-gallery-tile', 200)}
    setGalleryLook(current => current.gap === next.gap && current.inset === next.inset && current.tile === next.tile ? current : next)
  }, [galleryHost, timelineActive])
  const galleryInner = Math.max(0, galleryWindow.width - 2 * galleryLook.inset)
  const fitting = (tile: number) => Math.max(1, Math.round((galleryInner + galleryLook.gap) / (tile + galleryLook.gap)))
  // Each zoom level is a tile size, and every step out adds at least one
  // column, so a zoom is always visible even in a narrow pane where two sizes
  // would round to the same count.
  const timelineColumns = useMemo(() => {
    let previous = 0
    return (timelineLevels?.levels ?? []).map(level => (previous = Math.max(previous + 1, fitting(level.tile_px))))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timelineLevels, galleryInner, galleryLook.gap])
  const galleryTile = cardDetail?.tile_px ?? galleryLook.tile
  const columns = timelineActive && levelAt >= 0 ? timelineColumns[levelAt]! : Math.max(1, Math.floor((galleryInner + galleryLook.gap) / (galleryTile + galleryLook.gap)))
  const tileWidth = Math.max(1, (galleryInner - galleryLook.gap * (columns - 1)) / columns)
  // Replaced fields/records can replace tall loading content with a short picture. Keep the tallest height while
  // scrolling one content set, but measure a fresh set again instead of retaining its former loading height.
  const galleryMeasureKey = useMemo(() => ({timelineActive, tileWidth, detail: cardDetail?.id, fields, records}), [timelineActive, tileWidth, cardDetail?.id, fields, records])
  const measuredCard = useMeasuredHeight(galleryHost, '.record-views-gallery-card', 132, galleryMeasureKey, false, !timelineActive)
  const cardHeight = timelineActive ? tileWidth : measuredCard
  const galleryHeadingHeight = useMeasuredHeight(galleryHost, '.record-views-section-heading', 40, null)
  const gallery = useMemo(() => {
    type Line = {kind: 'heading'; block: Extract<SectionBlock, {kind: 'heading'}>} | {kind: 'row'; key: string; depth: number; records: any[]}
    const lines: Line[] = [], heights: number[] = [], lineOf = new Map<string, number>()
    if (view !== 'gallery') return {lines, offsets: offsetsOf(heights), lineOf}
    for (const block of drawnBlocks) {
      if (block.kind === 'heading') { lines.push({kind: 'heading', block}); heights.push(galleryHeadingHeight); continue }
      for (let at = 0; at < block.records.length; at += columns) {
        const records = block.records.slice(at, at + columns)
        for (const record of records) lineOf.set(identify(record), lines.length)
        lines.push({kind: 'row', key: `${block.key}:${identify(records[0])}`, depth: block.depth, records})
        heights.push(cardHeight + galleryLook.gap)
      }
    }
    return {lines, offsets: offsetsOf(heights), lineOf}
  }, [view, drawnBlocks, columns, cardHeight, galleryHeadingHeight, galleryLook.gap, identify])
  // A gallery with no width (a hidden tab) draws nothing until it is shown.
  const [galleryFrom, galleryTo] = galleryWindow.width > 0 ? visibleRange(gallery.offsets, galleryWindow.top - galleryLook.inset, galleryWindow.bottom - galleryLook.inset) : [0, 0]

  const tableHeaderHeight = useMeasuredHeight(tableHost, 'thead', 40, null)
  const tableRowHeight = useMeasuredHeight(tableHost, 'tbody tr[data-record-id]', 40, compactRows, true)
  const table = useMemo(() => {
    type Line = {kind: 'heading'; block: Extract<SectionBlock, {kind: 'heading'}>} | {kind: 'record'; key: string; record: any}
    const lines: Line[] = [], lineOf = new Map<string, number>(), copies = new Map<string, number>()
    if (view === 'table') for (const block of drawnBlocks) {
      if (block.kind === 'heading') { lines.push({kind: 'heading', block}); continue }
      for (const record of block.records) { const id = identify(record); copies.set(id, (copies.get(id) ?? 0) + 1); lineOf.set(id, lines.length); lines.push({kind: 'record', key: block.key, record}) }
    }
    return {lines, offsets: offsetsOf(lines.map(() => tableRowHeight)), lineOf, copies}
  }, [view, drawnBlocks, tableRowHeight, identify])
  const [tableFrom, tableTo] = visibleRange(table.offsets, tableWindow.top - tableHeaderHeight, tableWindow.bottom - tableHeaderHeight)

  /** Scroll so one record is on screen: centred when revealed from elsewhere,
   *  only as far as needed when a key moves to it. */
  const scrollToRecord = (id: string, placement: 'center' | 'nearest') => {
    const place = (host: HTMLElement | null, top: number | undefined, height: number) => {
      if (!host || top === undefined) return false
      const scroller = scrollerOf(host)
      const viewport = scroller === document.scrollingElement ? window.innerHeight : scroller.clientHeight
      const at = contentTopOf(host, scroller) + top
      const bar = surface.current?.querySelector<HTMLElement>('.record-views-bar')?.getBoundingClientRect().height ?? 0
      if (placement === 'center') scroller.scrollTop = at - (viewport - height) / 2
      else if (at - bar < scroller.scrollTop) scroller.scrollTop = at - bar
      else if (at + height > scroller.scrollTop + viewport) scroller.scrollTop = at + height - viewport
      return true
    }
    if (view === 'gallery') { const line = gallery.lineOf.get(id); if (line !== undefined && place(galleryHost, gallery.offsets[line]! + galleryLook.inset, cardHeight)) return }
    if (view === 'table') { const line = table.lineOf.get(id); if (line !== undefined && place(tableHost, table.offsets[line]! + tableHeaderHeight, tableRowHeight)) return }
    for (const element of surface.current?.querySelectorAll<HTMLElement>('[data-record-id]') ?? []) if (element.dataset.recordId === id) { element.scrollIntoView?.({block: placement}); break }
  }

  // Reveal: select the record, bring it into its place in the run and mark it
  // for a moment. Held until the record is in hand, since a caller may ask
  // before its records have arrived.
  const [revealedId, setRevealedId] = useState<string | null>(null)
  const pendingReveal = useRef<{id: string; nonce: number} | null>(null)
  const lastReveal = useRef<number | null>(null)
  if (reveal && reveal.nonce !== lastReveal.current) { lastReveal.current = reveal.nonce; pendingReveal.current = reveal }
  useLayoutEffect(() => {
    const wanted = pendingReveal.current
    if (!wanted || !orderedIds.includes(wanted.id) || (view === 'gallery' && !galleryHost) || (view === 'table' && !tableHost)) return
    pendingReveal.current = null
    anchor.current = lead.current = wanted.id
    changeSelection(new Set([wanted.id]))
    scrollToRecord(wanted.id, 'center')
    galleryWindow.sync(); tableWindow.sync()
    setRevealedId(wanted.id)
  })
  useEffect(() => {
    if (!revealedId) return
    const timer = window.setTimeout(() => setRevealedId(null), 2400)
    return () => window.clearTimeout(timer)
  }, [revealedId])

  // Zoom: fewer, bigger tiles or more, smaller ones, one level at a time. The
  // record under the pointer (or nearest the middle) stays where it was, and
  // the grid scales from the old size to the new around that point so the
  // change reads as one continuous zoom.
  const pendingZoom = useRef<{id: string; offset: number; point: {x: number; y: number}; ratio: number} | null>(null)
  const zoomBy = (step: number, point?: {x: number; y: number}) => {
    if (!timelineActive) return detailBy(step, point)
    if (!timelineLevels || !galleryHost) return false
    const next = Math.min(timelineLevels.levels.length - 1, Math.max(0, levelAt + step))
    if (next === levelAt) return false
    galleryHost.style.transform = ''
    const scroller = scrollerOf(galleryHost)
    const viewportTop = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top
    const viewportHeight = scroller === document.scrollingElement ? window.innerHeight : scroller.clientHeight
    const cards = [...galleryHost.querySelectorAll<HTMLElement>('[data-record-id]')]
    const under = point ? (document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>('[data-record-id]') ?? null) : null
    const middle = viewportTop + viewportHeight / 2
    const target = under && galleryHost.contains(under) ? under
      : cards.reduce<HTMLElement | null>((best, card) => { const box = card.getBoundingClientRect(), bestBox = best?.getBoundingClientRect(); return !bestBox || Math.abs(box.top + box.height / 2 - middle) < Math.abs(bestBox.top + bestBox.height / 2 - middle) ? card : best }, null)
    const nextLevel = timelineLevels.levels[next]!
    if (target?.dataset.recordId) {
      const box = target.getBoundingClientRect()
      pendingZoom.current = {id: target.dataset.recordId, offset: box.top - viewportTop, point: point ?? {x: box.left + box.width / 2, y: box.top + box.height / 2}, ratio: zoomLevel!.tile_px / nextLevel.tile_px}
    }
    setOwnLevelId(nextLevel.id)
    timeline?.onLevelChange?.(nextLevel.id)
    return true
  }
  // Detail: the same pinch on a gallery or board that is not a timeline changes how much each card says. In a
  // gallery the card under the pointer stays where it was while the grid scales into its new size; a board's cards
  // grow or shrink in place.
  const detailBy = (step: number, point?: {x: number; y: number}) => {
    if (!detailLevels || !detailActive || !detailLevel) return false
    const next = Math.min(detailLevels.levels.length - 1, Math.max(0, detailAt + step))
    if (next === detailAt) return false
    const nextLevel = detailLevels.levels[next]!
    const host = view === 'gallery' ? galleryHost : view === 'board' ? boardHost : callerHost
    if (host) {
      host.style.transform = ''
      const scroller = scrollerOf(host)
      const viewportTop = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top
      const under = point ? (document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>('[data-record-id]') ?? null) : null
      const target = under && host.contains(under) ? under : host.querySelector<HTMLElement>('[data-record-id]')
      if (target?.dataset.recordId) {
        const box = target.getBoundingClientRect()
        pendingZoom.current = {id: target.dataset.recordId, offset: box.top - viewportTop, point: point ?? {x: box.left + box.width / 2, y: box.top + box.height / 2}, ratio: detailLevel.tile_px / nextLevel.tile_px}
      }
    }
    setDetailId(nextLevel.id)
    persistPreferences({detail: nextLevel.id})
    return true
  }
  useLayoutEffect(() => {
    // A board's cards, or a view another part draws, grow or shrink in place around the point of the pinch.
    const host = view === 'board' ? boardHost : callerDraws ? callerHost : null
    if (!host) return
    const pending = pendingZoom.current
    if (!pending) return
    pendingZoom.current = null
    if (typeof host.animate !== 'function' || matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const box = host.getBoundingClientRect()
    const origin = `${pending.point.x - box.left}px ${pending.point.y - box.top}px`
    host.animate([{transform: `scale(${Math.sqrt(pending.ratio)})`, transformOrigin: origin, opacity: 0.6}, {transform: 'none', transformOrigin: origin, opacity: 1}], {duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)'})
  }, [cardDetail?.id])
  useLayoutEffect(() => {
    const pending = pendingZoom.current
    if (!pending || !galleryHost || view !== 'gallery') return
    pendingZoom.current = null
    const line = gallery.lineOf.get(pending.id)
    if (line === undefined) return
    const scroller = scrollerOf(galleryHost)
    scroller.scrollTop = contentTopOf(galleryHost, scroller) + galleryLook.inset + gallery.offsets[line]! - pending.offset
    galleryWindow.sync()
    if (typeof galleryHost.animate !== 'function' || matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const box = galleryHost.getBoundingClientRect()
    const origin = `${pending.point.x - box.left}px ${pending.point.y - box.top}px`
    galleryHost.animate([{transform: `scale(${pending.ratio})`, transformOrigin: origin, opacity: 0.7}, {transform: 'none', transformOrigin: origin, opacity: 1}], {duration: 240, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)'})
  }, [gallery])
  const zoomRef = useRef(zoomBy)
  zoomRef.current = zoomBy
  // Pinch on a trackpad (a ctrl-wheel in Chromium, gesture events in WebKit)
  // scales the grid live and steps a level once the pinch is large enough; ⌘+
  // and ⌘− step one level. Only while this gallery is the one in front.
  const pinchHost = view === 'gallery' ? galleryHost : view === 'board' ? boardHost : callerDraws ? callerHost : null
  const pinchable = timelineActive || detailActive
  useEffect(() => {
    if (!pinchable || !pinchHost || !surface.current) return
    const host = pinchHost, root = surface.current
    let scale = 1, settle = 0, gestureBase = 1
    const STEP = 1.32
    const live = (point: {x: number; y: number}) => {
      if (scale >= STEP && zoomRef.current(-1, point)) scale = 1
      else if (scale <= 1 / STEP && zoomRef.current(1, point)) scale = 1
      scale = Math.min(STEP, Math.max(1 / STEP, scale))
      const box = host.getBoundingClientRect()
      host.style.transformOrigin = `${point.x - box.left}px ${point.y - box.top}px`
      host.style.transform = scale === 1 ? '' : `scale(${scale})`
      window.clearTimeout(settle)
      settle = window.setTimeout(() => {
        scale = 1
        if (!host.style.transform) return
        const from = host.style.transform
        host.style.transform = ''
        host.animate?.([{transform: from}, {transform: 'none'}], {duration: 160, easing: 'ease-out'})
      }, 180)
    }
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return
      event.preventDefault()
      scale *= Math.exp(-event.deltaY * 0.01)
      live({x: event.clientX, y: event.clientY})
    }
    type Gesture = Event & {scale: number; clientX: number; clientY: number}
    const gestureStart = (event: Event) => { event.preventDefault(); gestureBase = 1 }
    const gestureChange = (event: Event) => {
      const gesture = event as Gesture
      event.preventDefault()
      scale *= gesture.scale / gestureBase
      gestureBase = gesture.scale
      live({x: gesture.clientX, y: gesture.clientY})
    }
    // Two fingers on a touch screen: the change in their distance is the pinch, centred between them.
    let touchApart = 0
    const apart = (touches: TouchList) => Math.hypot(touches[0]!.clientX - touches[1]!.clientX, touches[0]!.clientY - touches[1]!.clientY)
    const touchStart = (event: TouchEvent) => { touchApart = event.touches.length === 2 ? apart(event.touches) : 0 }
    const touchMove = (event: TouchEvent) => {
      if (event.touches.length !== 2 || !touchApart) return
      event.preventDefault()
      const now = apart(event.touches)
      scale *= now / touchApart
      touchApart = now
      live({x: (event.touches[0]!.clientX + event.touches[1]!.clientX) / 2, y: (event.touches[0]!.clientY + event.touches[1]!.clientY) / 2})
    }
    const touchEnd = (event: TouchEvent) => { if (event.touches.length < 2) touchApart = 0 }
    let pointer: {x: number; y: number} | undefined
    const track = (event: PointerEvent) => { pointer = {x: event.clientX, y: event.clientY} }
    const key = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const step = event.key === '=' || event.key === '+' ? -1 : event.key === '-' || event.key === '_' ? 1 : 0
      if (!step || !host.isConnected || !host.getClientRects().length) return
      const active = document.activeElement as HTMLElement | null
      if (active?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (!(root.contains(active) || !active || active === document.body || root.matches(':hover'))) return
      event.preventDefault()
      zoomRef.current(step, pointer && root.matches(':hover') ? pointer : undefined)
    }
    root.addEventListener('wheel', wheel, {passive: false})
    root.addEventListener('gesturestart', gestureStart)
    root.addEventListener('gesturechange', gestureChange)
    root.addEventListener('pointermove', track)
    root.addEventListener('touchstart', touchStart, {passive: true})
    root.addEventListener('touchmove', touchMove, {passive: false})
    root.addEventListener('touchend', touchEnd)
    root.addEventListener('touchcancel', touchEnd)
    window.addEventListener('keydown', key)
    return () => {
      window.clearTimeout(settle)
      host.style.transform = ''
      root.removeEventListener('wheel', wheel)
      root.removeEventListener('gesturestart', gestureStart)
      root.removeEventListener('gesturechange', gestureChange)
      root.removeEventListener('pointermove', track)
      root.removeEventListener('touchstart', touchStart)
      root.removeEventListener('touchmove', touchMove)
      root.removeEventListener('touchend', touchEnd)
      root.removeEventListener('touchcancel', touchEnd)
      window.removeEventListener('keydown', key)
    }
  }, [pinchable, pinchHost])

  // ---------------------------------------------------------------------------
  // Columns: the whole header cell opens its menu (Twenty's record table), and
  // every row in it is derived from what the field can do and where the column
  // sits, so a row that cannot apply is never offered.
  // Keep the saved freeze choice, but let columns scroll in a pane too small
  // to show a full unfrozen column beside the pinned cells and row actions.
  // The existing table window supplies its actual width after any rearrangement.
  let frozenCount = Math.min(frozen, shown.length)
  while (frozenCount > 0) {
    const pinnedWidth = shown.slice(0, frozenCount).reduce((sum, field) => sum + widthFor(field), 0)
    const nextWidth = widthFor(shown[Math.min(frozenCount, shown.length - 1)]!)
    if (32 + pinnedWidth + nextWidth + (rowMenu ? 40 : 0) <= tableWindow.width) break
    frozenCount -= 1
  }
  const moveColumn = (field: FieldDescriptor, step: number) => {
    const other = shown[shown.indexOf(field) + step]
    if (!other || other === identifying || field === identifying) return
    const next = [...order]
    const from = next.indexOf(field.id), to = next.indexOf(other.id)
    next[from] = other.id
    next[to] = field.id
    changeOrder(next)
  }
  const ALIGN_ROWS: {id: ColumnAlign; label: string; icon: string}[] = [
    {id: 'left', label: 'Left', icon: 'align-left'},
    {id: 'center', label: 'Center', icon: 'align-center'},
    {id: 'right', label: 'Right', icon: 'align-right'},
  ]
  const columnMenuItems = (field: FieldDescriptor): ActionMenuItem[] => {
    const at = shown.indexOf(field)
    const movable = field !== identifying
    const grouped = levels.some(level => level.field === field.id)
    const align = alignFor(field)
    return [
      ...(field.sortable !== false ? [
        {id: 'sort-asc', label: 'Sort ascending', icon: 'arrow-up-narrow-wide', group: 'sort', checked: sort?.fieldId === field.id && sort.direction === 'asc'},
        {id: 'sort-desc', label: 'Sort descending', icon: 'arrow-down-wide-narrow', group: 'sort', checked: sort?.fieldId === field.id && sort.direction === 'desc'},
      ] : []),
      ...(field.filterable && ruleOperators && field.ruleKind ? [{id: 'filter', label: 'Filter by this', icon: 'list-filter', group: 'view'}] : []),
      ...(field.groupable ? [{id: 'group', label: grouped ? 'Stop grouping' : 'Group by this', icon: 'rows-3', group: 'view', checked: grouped}] : []),
      at < frozenCount
        ? {id: 'unfreeze', label: 'Unfreeze', icon: 'pin-off', group: 'layout'}
        : {id: 'freeze', label: 'Freeze up to here', icon: 'pin', group: 'layout'},
      {id: 'align', label: 'Align', icon: `align-${align}`, group: 'layout', hint: ALIGN_ROWS.find(row => row.id === align)!.label,
        items: ALIGN_ROWS.map(row => ({id: `align:${row.id}`, label: row.label, icon: row.icon, checked: row.id === align}))},
      ...(columnWidths[field.id] !== undefined ? [{id: 'reset-width', label: 'Reset width', icon: 'move-horizontal', group: 'layout'}] : []),
      ...(movable && at > 1 ? [{id: 'move-left', label: 'Move left', icon: 'arrow-left', group: 'move'}] : []),
      ...(movable && at < shown.length - 1 ? [{id: 'move-right', label: 'Move right', icon: 'arrow-right', group: 'move'}] : []),
      ...(movable ? [{id: 'hide', label: 'Hide', icon: 'eye-off', group: 'hide'}] : []),
    ]
  }
  const runColumnAction = (field: FieldDescriptor, id: string) => {
    const at = shown.indexOf(field)
    const actions: Record<string, () => void> = {
      'sort-asc': () => setSort({fieldId: field.id, direction: 'asc'}),
      'sort-desc': () => setSort({fieldId: field.id, direction: 'desc'}),
      filter: () => addFilter(field),
      group: () => toggleLevel(field.id),
      freeze: () => setFrozen(at + 1),
      unfreeze: () => setFrozen(at),
      'reset-width': () => resetWidth(field),
      'move-left': () => moveColumn(field, -1),
      'move-right': () => moveColumn(field, 1),
      hide: () => setHidden(new Set([...hidden, field.id])),
      ...Object.fromEntries(ALIGN_ROWS.map(row => [`align:${row.id}`, () => setAlign(field, row.id)])),
    }
    actions[id]?.()
  }
  const columnMenu = (field: FieldDescriptor) => (
    <ActionMenu
      label={`${field.label} column options`}
      align="start"
      side="bottom"
      popupClassName="record-views-column-menu"
      trigger={<Button variant="ghost" size="sm" className="record-views-column-trigger"/>}
      triggerContent={<NamedIcon name="more-horizontal" size="sm" className="record-views-column-icon" aria-hidden/>}
      items={columnMenuItems(field)}
      onAction={id => runColumnAction(field, id)}
    />
  )
  const toggleSort = (field: FieldDescriptor) => setSort(current => ({
    fieldId: field.id,
    direction: current?.fieldId === field.id && current.direction === 'asc' ? 'desc' : 'asc',
  }))
  // Frozen columns stay in place while the table scrolls sideways: each one's
  // left edge is the checkbox column plus every frozen column before it.
  const frozenLeft = (at: number) => 32 + shown.slice(0, at).reduce((sum, field) => sum + widthFor(field), 0)
  const columnPlace = (field: FieldDescriptor) => {
    const at = shown.indexOf(field)
    return {
      'data-align': alignFor(field),
      ...(at < frozenCount ? {'data-frozen': at === frozenCount - 1 ? 'edge' : 'true', style: {'--record-views-frozen-left': `${frozenLeft(at)}px`} as React.CSSProperties} : {}),
    }
  }
  const [scrolledSideways, setScrolledSideways] = useState(false)

  // ---------------------------------------------------------------------------
  // The tools in the view bar. Every one is a shared ActionMenu opened from the
  // shared ExpandableTabs toolbar, and every field list in them is the one
  // field order, dragged by its grip in any of them.
  const [openTool, setOpenTool] = useState<string | null>(null)
  const [builderOpen, setBuilderOpen] = useState(false)
  const toolMenu = (id: string, name: string, menu: (props: {trigger: React.ReactElement; triggerContent: React.ReactNode; label: string; onOpenChange: (open: boolean) => void}) => React.ReactElement) =>
    (button: React.ReactElement) => menu({trigger: button, triggerContent: (button.props as {children?: React.ReactNode}).children, label: name, onOpenChange: open => setOpenTool(current => (open ? id : current === id ? null : current))})
  const bucketOf = (level: GroupLevel) => {
    const field = byId.get(level.field)
    const buckets = field ? bucketsFor(field, isDateField(field)) : []
    return buckets.find(bucket => bucket.id === level.bucket) ?? buckets[0]
  }
  const setLevel = (fieldId: string, bucket?: string) => {
    const at = levels.findIndex(level => level.field === fieldId)
    changeLevels(at >= 0 ? levels.map((level, index) => (index === at ? {field: fieldId, ...(bucket ? {bucket} : {})} : level)) : [...levels, {field: fieldId, ...(bucket ? {bucket} : {})}])
  }
  const toggleLevel = (fieldId: string) => {
    if (levels.some(level => level.field === fieldId)) changeLevels(levels.filter(level => level.field !== fieldId))
    else setLevel(fieldId)
  }
  const groupActions = new Map<string, () => void>()
  const groupItems: ActionMenuItem[] = groupable.map(field => {
    const at = levels.findIndex(level => level.field === field.id)
    const buckets = bucketsFor(field, isDateField(field))
    const place = at >= 0 && levels.length > 1 ? `${at + 1}` : ''
    const row: ActionMenuItem = {id: `group:${field.id}`, label: field.label, icon: field.icon || 'rows-3', group: 'fields', checked: at >= 0, hint: place || undefined, keepOpen: true}
    groupActions.set(row.id, () => toggleLevel(field.id))
    if (!buckets.length) return row
    const current = at >= 0 ? bucketOf(levels[at]) : undefined
    return {
      ...row,
      checked: false,
      hint: at >= 0 ? [place, current?.label].filter(Boolean).join(' · ') : undefined,
      items: [
        ...buckets.map(bucket => {
          const id = `bucket:${field.id}:${bucket.id}`
          groupActions.set(id, () => setLevel(field.id, bucket.id))
          return {id, label: bucket.label, icon: bucket.icon, checked: current?.id === bucket.id, keepOpen: true}
        }),
        ...(at >= 0 ? [{id: `ungroup:${field.id}`, label: 'Stop grouping by this', icon: 'x', group: 'stop'}] : []),
      ],
    }
  })
  for (const field of groupable) groupActions.set(`ungroup:${field.id}`, () => changeLevels(levels.filter(level => level.field !== field.id)))
  // Grouping off is a choice of its own at the top of the menu, checked while
  // nothing groups the records, so turning it off never means hunting for the
  // field that is on.
  groupActions.set('group-none', () => changeLevels([]))
  const groupDetail = levels.map(level => { const bucket = bucketOf(level); const name = byId.get(level.field)?.label ?? ''; return bucket && bucket.id !== bucketsFor(byId.get(level.field)!, isDateField(byId.get(level.field)!))[0]?.id ? `${name} by ${bucket.label.toLocaleLowerCase()}` : name }).join(', ')

  const sortable = ordered.filter(field => field.sortable !== false)
  const sortActions = new Map<string, () => void>()
  const sortItems: ActionMenuItem[] = [
    ...sortable.map(field => {
      const up = `asc:${field.id}`, down = `desc:${field.id}`
      sortActions.set(up, () => setSort({fieldId: field.id, direction: 'asc'}))
      sortActions.set(down, () => setSort({fieldId: field.id, direction: 'desc'}))
      const active = sort?.fieldId === field.id
      return {id: `sort:${field.id}`, label: field.label, icon: field.icon || 'arrow-up-down', group: 'fields', hint: active ? (sort!.direction === 'asc' ? 'Ascending' : 'Descending') : undefined, items: [
        {id: up, label: 'Ascending', icon: 'arrow-up-narrow-wide', checked: active && sort!.direction === 'asc'},
        {id: down, label: 'Descending', icon: 'arrow-down-wide-narrow', checked: active && sort!.direction === 'desc'},
      ]}
    }),
    ...(sort ? [{id: 'clear-sort', label: 'Clear sort', icon: 'x', group: 'clear', reorderable: false}] : []),
  ]
  sortActions.set('clear-sort', () => setSort(null))
  const sortField = sort ? byId.get(sort.fieldId) : undefined

  const fieldItems: ActionMenuItem[] = [
    ...ordered.map(field => ({id: `field:${field.id}`, label: field.label, icon: field.icon || 'columns-3', group: 'fields', checked: !hidden.has(field.id), keepOpen: true, disabled: field.id === identifying?.id, reorderable: field.id !== identifying?.id})),
    ...(view === 'table' ? [{id: 'density', label: compactRows ? 'Use comfortable rows' : 'Use compact rows', icon: compactRows ? 'rows-2' : 'rows-4', group: 'density', reorderable: false}] : []),
  ]
  const toggleField = (id: string) => { const next = new Set(hidden); if (next.has(id)) next.delete(id); else next.add(id); setHidden(next) }
  const filterCount = countRules(rules)

  const tools: ExpandableTabItem[] = [
    ...(groupable.length ? [{
      id: 'group', label: 'Group by', icon: 'rows-3', detail: groupDetail || undefined, pinned: levels.length > 0 || openTool === 'group',
      wrap: toolMenu('group', groupDetail ? `Group by, ${groupDetail}` : 'Group by', ({trigger, triggerContent, label: name, onOpenChange}) => (
        <ActionMenu modal={false} label={name} align="start" trigger={trigger} triggerContent={triggerContent} onOpenChange={onOpenChange} popupClassName="record-views-group-menu"
          items={[{id: 'group-none', label: 'None', icon: 'circle-off', group: 'none', checked: !levels.length, reorderable: false}, ...groupItems]}
          onReorder={ids => reorderWithin(ids.filter(id => id.startsWith('group:')).map(id => id.slice(6)))}
          onAction={id => groupActions.get(id)?.()}/>
      )),
    }] : []),
    ...(ruleOperators && ruleFields.length ? [{
      id: 'filter', label: 'Filter', icon: 'list-filter', badge: filterCount || undefined,
      wrap: toolMenu('filter', filterCount ? `Filter, ${filterCount}` : 'Filter', ({trigger, triggerContent}) => (
        <React.Suspense fallback={trigger}><RuleFilterMenu fields={ruleFields} operators={ruleOperators} value={rules} onChange={changeRules} facets={facets}
          trigger={trigger} triggerContent={triggerContent}
          onFieldOrderChange={reorderWithin}
          onOpenBuilder={() => setTimeout(() => setBuilderOpen(true))}/></React.Suspense>
      )),
    }] : []),
    {
      id: 'sort', label: 'Sort', icon: 'arrow-up-down', detail: sortField ? `${sortField.label} ${sort!.direction === 'asc' ? '↑' : '↓'}` : undefined, pinned: !!sort || openTool === 'sort',
      wrap: toolMenu('sort', sortField ? `Sort, ${sortField.label}` : 'Sort', ({trigger, triggerContent, label: name, onOpenChange}) => (
        <ActionMenu modal={false} label={name} align="start" trigger={trigger} triggerContent={triggerContent} onOpenChange={onOpenChange} items={sortItems}
          onReorder={ids => reorderWithin(ids.filter(id => id.startsWith('sort:')).map(id => id.slice(5)))}
          onAction={id => sortActions.get(id)?.()}/>
      )),
    },
    ...(savedViews.length > 0 || onSaveView || designedNow || savedViewsState ? [{
      id: 'views', label: 'Saved configurations', icon: 'bookmark', pinned: openTool === 'views',
      wrap: toolMenu('views', 'Saved configurations', ({trigger, triggerContent, label: name, onOpenChange}) => (
        <ActionMenu modal={false} label={name} align="end" trigger={trigger} triggerContent={triggerContent} onOpenChange={onOpenChange}
          header={savedViewsState?.error ? <p className="record-views-configuration-error" role="alert">{savedViewsState.error}</p> : undefined}
          items={[
            ...savedViews.map(saved => ({id: 'view:' + saved.id, label: saved.owner?.name ? `${saved.label} · ${saved.owner.name}` : saved.label,
              icon: 'bookmark', group: 'views', checked: saved.id === activeSavedId})),
            ...(savedViewsState?.loading ? [{id: 'configurations-loading', label: 'Loading configurations…', icon: 'loader-circle', disabled: true, group: 'catalog'}] : []),
            ...(savedViewsState?.error ? [{id: 'configurations-error', label: 'Configurations could not load', icon: 'circle-alert', disabled: true, group: 'catalog'},
              ...(onReloadSavedViews ? [{id: 'configurations-retry', label: 'Try loading again', icon: 'refresh-cw', group: 'catalog', disabled: configurationBusy || savedViewsState.loading}] : [])] : []),
            ...(!savedViews.length && !savedViewsState?.loading && !savedViewsState?.error ? [{id: 'configurations-empty', label: 'No saved configurations yet', icon: 'bookmark', disabled: true, group: 'catalog'}] : []),
            ...(savedViewsState?.hasMore && onLoadMoreSavedViews ? [{id: 'configurations-more', label: 'Load more configurations', icon: 'chevron-down', group: 'catalog', disabled: configurationBusy || savedViewsState.loading}] : []),
            ...(onSaveView ? [{id: 'save', label: 'Save configuration', icon: 'bookmark-plus', group: 'save', disabled: configurationBusy}] : []),
            ...(activeSaved && canUpdateConfiguration ? [
              {id: 'update-view', label: 'Save changes to this configuration', icon: 'save', group: 'save', disabled: configurationBusy},
              {id: 'rename-view', label: 'Rename this configuration', icon: 'pencil', group: 'save', disabled: configurationBusy},
              ...(fields.some(field => field.ruleKind === 'date') ? [{id: 'time-view', label: 'Time range', icon: 'calendar-range', group: 'save', disabled: configurationBusy}] : []),
            ] : []),
            ...(activeSaved && !activeSaved.readOnly && activeSaved.canRemove !== false && onRemoveSavedView ? [{id: 'remove-view', label: 'Remove this configuration', icon: 'trash-2', group: 'save', disabled: configurationBusy}] : []),
            ...(activeSaved && activeSaved.canShare !== false && onShareSavedView ? [{id: 'share-view', label: 'Share this configuration', icon: 'share-2', group: 'share', disabled: configurationBusy}] : []),
            ...(activeSaved && onCopySavedViewLink ? [{id: 'copy-view-link', label: 'Copy configuration link', icon: 'link', group: 'share', disabled: configurationBusy}] : []),
            ...(designedNow ? [{id: 'save-design', label: 'Use this layout on every list', icon: 'layout-template', group: 'save', disabled: configurationBusy}] : []),
          ]}
          onAction={id => {
            if (id === 'save') { setEditingSavedId(null); setSavingDesign(false); setSavingAspects(configurationAspects.map(aspect => aspect.id)); setConfigurationError(null); setSavingView(true) }
            else if (id === 'update-view' && activeSaved && canUpdateConfiguration) void runConfigurationAction(() => onUpdateSavedView!({id: activeSaved.id,
              ...(activeSaved.revision === undefined ? {} : {revision: activeSaved.revision}), ...currentViewRow(activeSaved.label, activeSaved.aspects)}))
            else if (id === 'rename-view' && activeSaved && canUpdateConfiguration) { setEditingSavedId(activeSaved.id); setSavedViewName(activeSaved.label); setSavingDesign(false); setConfigurationError(null); setSavingView(true) }
            else if (id === 'time-view' && canUpdateConfiguration) { setConfigurationError(null); setEditingTime(true) }
            else if (id === 'remove-view' && activeSaved && !activeSaved.readOnly && activeSaved.canRemove !== false) { setConfigurationError(null); setAskingRemoveView(true) }
            else if (id === 'share-view' && activeSaved && activeSaved.canShare !== false && onShareSavedView) void runConfigurationAction(() => onShareSavedView(activeSaved.id))
            else if (id === 'copy-view-link' && activeSaved && onCopySavedViewLink) void runConfigurationAction(() => onCopySavedViewLink(activeSaved.id))
            else if (id === 'configurations-retry' && onReloadSavedViews) void runConfigurationAction(onReloadSavedViews)
            else if (id === 'configurations-more' && onLoadMoreSavedViews) void runConfigurationAction(onLoadMoreSavedViews)
            else if (id === 'save-design') { setSavingDesign(true); setEditingSavedId(null); setSavedViewName(designedNow?.label ?? ''); setConfigurationError(null); setSavingView(true) }
            else { const saved = savedViews.find(candidate => 'view:' + candidate.id === id); if (saved) applySavedView(saved) }
          }}/>
      )),
    }] : []),
    {
      id: 'fields', label: 'Fields', icon: 'columns-3', pinned: openTool === 'fields',
      wrap: toolMenu('fields', 'Fields', ({trigger, triggerContent, label: name, onOpenChange}) => (
        <ActionMenu modal={false} label={name} align="end" trigger={trigger} triggerContent={triggerContent} onOpenChange={onOpenChange} popupClassName="record-views-fields-popup"
          items={fieldItems}
          onReorder={ids => reorderWithin(ids.filter(id => id.startsWith('field:')).map(id => id.slice(6)))}
          onAction={id => id === 'density' ? changeDensity(!compactRows) : toggleField(id.slice(6))}>
          {onAddField && <CustomFieldForm fields={fields} kinds={customFieldKinds} onAdd={onAddField} />}
        </ActionMenu>
      )),
    },
    ...(moreActions ? [
      {type: 'separator' as const, id: 'more-separator'},
      {
        id: 'more', label: moreActions.label, icon: moreActions.icon, detail: moreActions.detail, badge: moreActions.badge, pinned: !!moreActions.detail || openTool === 'more',
        wrap: toolMenu('more', moreActions.detail ? `${moreActions.label}, ${moreActions.detail}` : moreActions.label, ({trigger, triggerContent, label: name, onOpenChange}) => (
          <ActionMenu modal={false} label={name} align="end" trigger={trigger} triggerContent={triggerContent} onOpenChange={onOpenChange} items={moreActions.items} onAction={moreActions.onAction}/>
        )),
      },
    ] : []),
  ]

  // A view the caller draws replaces the built-in one of the same id; the two are never drawn together.
  const drawnHere = callerView ? null : view
  const searchHasWords = Boolean((callerSearch?.value ?? search).trim())
  // A React view placing this owner's controls must survive an empty result,
  // otherwise the person loses the search box needed to clear their query.
  const callerOwnsEmpty = Boolean(callerView?.ownsEmpty || (!showToolbar && callerView?.render))
  const filtering = ruleInForce && !filterRecords ? (filterError ? 'failed' as const : 'applying' as const) : null
  const derivedReadReady = !derivedProjectionPending && !derivedProjectionError && !projectionPending && !projectionError
  const showEmpty = derivedReadReady && !derivedProjectionIncomplete && !callerOwnsEmpty && visible.length === 0 && (emptyContent != null || searchHasWords || !callerView)

  // A caller-drawn view may place the existing controls in its own panes. State,
  // query, view changes and actions still have this one owner.
  const primaryActionControl = primaryAction ? <Button variant="outline" size="sm" aria-label={primaryAction.label} onClick={primaryAction.onSelect}>
    {primaryAction.icon && <NamedIcon name={primaryAction.icon} size="xs" aria-hidden/>}
    <span className="record-views-primary-label">{primaryAction.label}</span>
  </Button> : null
  const callerActions = toolbarEnd ? <span className="record-views-toolbar-end">{toolbarEnd}</span> : null
  const primaryActions = <span className="record-views-primary-actions">{callerActions}{primaryActionControl}</span>
  const displayActions = <span className="record-views-display-actions">
            {(() => {
              // One zoom pair for both kinds of zoom: a timeline's calendar levels, or how much each card says.
              const zoomLevels: {label: string}[] | undefined = timelineActive ? timelineLevels?.levels : detailActive ? detailLevels?.levels : undefined
              const at = timelineActive ? levelAt : detailAt
              if (!zoomLevels) return null
              return (
                <ExpandableTabs
                  mode="action"
                  size="sm"
                  ariaLabel="Zoom"
                  className="record-views-zoom"
                  onSelect={id => zoomBy(id === 'zoom-out' ? 1 : -1)}
                  items={[
                    {id: 'zoom-out', label: 'Zoom out', icon: 'zoom-out', detail: at < zoomLevels.length - 1 ? zoomLevels[at + 1]!.label : undefined, disabled: at >= zoomLevels.length - 1},
                    {id: 'zoom-in', label: 'Zoom in', icon: 'zoom-in', detail: at > 0 ? zoomLevels[at - 1]!.label : undefined, disabled: at <= 0},
                  ]}
                />
              )
            })()}
            <ExpandableTabs
              mode="action"
              size="sm"
              ariaLabel="View options"
              className="record-views-tools"
              labelDisplay="tooltip"
              items={tools}
            />
  </span>

  const toolbar = {
    search: (
          <span className="record-views-find">
            {callerSearch ? (
              <SearchField
                className="record-views-search"
                label={`Search ${label.toLowerCase()}`}
                placeholder={callerSearch.placeholder ?? 'Search'}
                value={draft}
                onChange={event => { const next = event.target.value; setDraft(next); if (!next && callerSearch.value) callerSearch.onCommit('') }}
                onKeyDown={event => { if (event.key === 'Enter') callerSearch.onCommit(draft) }}
                onBlur={() => { if (draft !== callerSearch.value) callerSearch.onCommit(draft) }}
              />
            ) : (
              <SearchField className="record-views-search" label={`Search ${label.toLowerCase()}`} placeholder="Search" value={search} onChange={event => changeSearch(event.target.value)}/>
            )}
          </span>
    ),
    views: (<>
          {views.length > 1 && (() => {
            const tabs = views.filter(option => givenViews.some(mine => mine.id === option.id) || option.id === view)
            const more = views.filter(option => !tabs.includes(option))
            return (
              <ExpandableTabs
                className="record-views-switch"
                ariaLabel="View"
                reserveHoverRoom
                size="sm"
                value={view}
                onChange={id => { if (id !== MORE_VIEWS) changeView(id) }}
                items={[
                  ...tabs.map(option => ({id: option.id, label: option.label, icon: option.icon ?? 'LayoutList'})),
                  ...(more.length ? [{
                    id: MORE_VIEWS, label: 'Views', icon: 'layout-grid', pinned: openTool === MORE_VIEWS,
                    wrap: toolMenu(MORE_VIEWS, 'Views', ({trigger, triggerContent, label: name, onOpenChange}) => (
                      <ActionMenu modal={false} label={name} align="end" trigger={trigger} triggerContent={triggerContent} onOpenChange={onOpenChange}
                        items={more.map(option => ({id: option.id, label: option.label, icon: option.icon ?? 'LayoutList'}))}
                        onAction={changeView}/>
                    )),
                  }] : []),
                ]}
              />
            )
          })()}
    </>),
    primaryActions,
    displayActions,
    actions: <span className="record-views-bar-actions">{callerActions}{displayActions}{primaryActionControl}</span>,
  }

  return (
    <section className="record-views coss-ui" aria-label={label} data-density={compactRows ? 'compact' : 'default'} ref={surface} tabIndex={-1} onKeyDown={keyDown}>
      {marquee && (
        <span
          className="record-views-marquee"
          aria-hidden="true"
          style={{left: marquee.left, top: marquee.top, width: marquee.width, height: marquee.height}}
        />
      )}
      <span ref={barMarker} className="record-views-bar-marker" aria-hidden="true"/>
      {/* The view bar sits on the pane itself, the way a sidebar list heading
          does: the title and its count chip, the search in the middle, the
          view switch and the tools. Its layout comes from its own width
          (record-table.css container queries), never from what is hovered,
          so a tool opening its name never moves another control. */}
      {showToolbar ? <div className="record-views-bar" data-pinned={barPinned ? 'true' : undefined}>
        <div className="record-views-bar-layout">
          <span className="record-views-title">
            <span className="record-views-title-text">{label}</span>
            {showCount && <CountChip variant="neutral" size="sm" className="record-views-title-count" aria-label={`${titleCount.toLocaleString()} records`}>{titleCount.toLocaleString()}</CountChip>}
            {toolbarStart && <ToolbarSlot mount={toolbarStart}/>}
          </span>

          {toolbar.search}

          {/* The only place a view is chosen: the shared icon tab control, the
              chosen view shows its name. The list's own views are tabs; the
              views offered to every list wait in one Views menu at its end,
              and the one chosen from it joins the tabs while it is shown. */}
          {toolbar.views}

          {/* The tools sit together at the bar's end: the zoom pair, then one
              toolbar in the sidebar's pattern (an icon per tool, its name shown
              on hover, what it currently holds beside it). Neither keeps hidden
              room for a label: a pointed-at icon never grows, so the reserve only
              ever showed as a gap between the groups. */}
          {toolbar.actions}
        </div>
      </div>

      : null}

      {/* A focus set at a wider level (the whole app, this arrangement) is a
          chip here, with its own way to clear it; a focus this list cannot
          read leaves the records alone and draws nothing. */}
      {inherited.applied.length > 0 && (
        <div className="record-views-focus" role="group" aria-label="Focus from elsewhere">
          {inherited.applied.map(link => (
            <span key={link.nodeId} className="record-views-focus-chip">
              <CountChip variant="muted-outline" size="md">Focus: {ruleWords(link.rule) || link.nodeId}</CountChip>
              <Button variant="ghost" size="icon-xs" aria-label={`Clear focus ${ruleWords(link.rule)}`} onClick={() => nodeRules.write(link.nodeId, null)}>
                <NamedIcon name="x" size="xs" aria-hidden/>
              </Button>
            </span>
          ))}
        </div>
      )}

      {ruleOperators && (countRules(rules) > 0 || builderOpen) && (
        <div className="record-views-filters">
          <RuleFilterChips fields={ruleFields} operators={ruleOperators} value={rules} onChange={changeRules} facets={facets} builderOpen={builderOpen} onBuilderOpenChange={setBuilderOpen}/>
        </div>
      )}

      {configurationError && <div className="record-views-configuration-error" role="alert">{configurationError}</div>}
      {derivedProjectionPending && <div className="record-views-status" role="status">Reading calculated values…</div>}
      {derivedProjectionError && <div className="record-views-configuration-error" role="alert">Calculated values could not be read. <Button variant="outline" size="sm" onClick={() => setDerivedProjectionRetry(value => value + 1)}>Retry</Button></div>}
      {derivedProjectionIncomplete && <div className="record-views-configuration-error" role="alert">Some calculated values could not be read.</div>}
      {projectionPending && <div className="record-views-status" role="status">Applying configuration…</div>}
      {projectionError && <div className="record-views-configuration-error" role="alert">{projectionError} <Button variant="outline" size="sm" onClick={() => setProjectionRetry(value => value + 1)}>Retry configuration</Button></div>}

      {savingView && (onSaveView || onUpdateSavedView || savingDesign) && (
        <form className="record-views-configuration-editor" aria-label={savingDesign ? 'Save layout' : editingSavedId ? 'Rename configuration' : 'Save current configuration'}
          onSubmit={event => {event.preventDefault(); void saveView()}}>
          <div className="record-views-saved-view-editor">
            <Input aria-label={savingDesign ? 'Layout name' : 'Configuration name'} placeholder={savingDesign ? 'Name this layout' : 'Name this configuration'}
              value={savedViewName} disabled={configurationBusy} onChange={event => setSavedViewName(event.target.value)}/>
            <Button type="submit" variant="outline" size="sm" disabled={configurationBusy || !savedViewName.trim() || (!editingSavedId && !savingDesign && !savingAspects.length)}>
              {configurationBusy ? 'Saving…' : editingSavedId ? 'Save name' : savingDesign ? 'Save layout' : 'Save configuration'}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={configurationBusy} onClick={() => {setSavingView(false); setSavingDesign(false); setEditingSavedId(null); setSavedViewName(''); setConfigurationError(null)}}>Cancel</Button>
          </div>
          {!editingSavedId && !savingDesign && <fieldset className="record-views-configuration-aspects" disabled={configurationBusy}>
            <legend>Settings to include</legend>
            {configurationAspects.map(aspect => <label key={aspect.id}>
              <Checkbox checked={savingAspects.includes(aspect.id)} onCheckedChange={checked => setSavingAspects(current => checked ? [...current.filter(id => id !== aspect.id), aspect.id] : current.filter(id => id !== aspect.id))}/>
              <span>{aspect.label}</span>
            </label>)}
            <p>{savingAspects.length === configurationAspects.length ? 'All settings will be saved.' : 'Only selected settings will change when this configuration is opened.'}</p>
          </fieldset>}
        </form>
      )}

      {askingRemoveView && activeSaved && !activeSaved.readOnly && activeSaved.canRemove !== false && onRemoveSavedView && (
        <div className="record-views-saved-view-editor" role="group" aria-label={`Remove ${activeSaved.label}?`}>
          <span>Remove {activeSaved.label}?</span>
          <Button variant="outline" size="sm" disabled={configurationBusy} onClick={async () => {
            const removing = activeSaved.id
            if (await runConfigurationAction(() => onRemoveSavedView(removing))) {setActiveSavedId(current => current === removing ? null : current); setAskingRemoveView(false)}
          }}>Remove configuration</Button>
          <Button variant="ghost" size="sm" disabled={configurationBusy} onClick={() => setAskingRemoveView(false)}>Cancel</Button>
        </div>
      )}

      {editingTime && activeSaved && canUpdateConfiguration && <React.Suspense fallback={null}><SavedViewTimeEditor fields={fields.filter(field => field.ruleKind === 'date')} value={configurationTime} busy={configurationBusy}
        onSave={async time => {
          const updated = {...currentViewRow(activeSaved.label, [...new Set([...selectedConfigurationAspects(activeSaved.aspects), 'time'])]), id: activeSaved.id, time,
            ...(activeSaved.revision === undefined ? {} : {revision: activeSaved.revision})}
          if (await runConfigurationAction(() => onUpdateSavedView!(updated))) {
            setConfigurationTime(time); setEditingTime(false); onApplySavedView?.(updated)
          }
        }} onCancel={() => setEditingTime(false)}/></React.Suspense>}

      {/* Refreshing values changes the rows and read notice, never the caller's
          React owner. Its open controls and unsaved drafts stay mounted. */}
      {!showEmpty && callerView?.mount && <CallerView mount={callerView.mount} records={visible} open={onOpen}/>}
      {!showEmpty && callerView?.render && !callerView.mount && <div className="record-views-caller-view" ref={setCallerHost} data-detail={cardDetail?.id}>{callerView.render({records: visible, toolbar, searchText: callerSearch?.value ?? search, open: onOpen, visibleFields: shown, formatFieldValue, fields, label, identify, nesting, write, reread, groupLevels: levels, sections: sectionTree, sort: [...(sort ? [{field: sort.fieldId, direction: sort.direction}] : []), ...secondarySort], rowActions, aboutRecord: record => aboutOf(record) ?? null, compose, designExtras, designAction, detail: cardDetail, identity: identity ?? resolvedPreferenceKey, links, statusField, adds, settings: settingsOfView, saveSettings: saveSettingsOfView, filtering})}</div>}

      {status && <div className="record-views-status">{status}</div>}
      {/* A view that owns its empty result is handed no rows while the filter arrives or after it failed: the list says
          which, with the same Retry, rather than leave the view to read as empty. */}
      {callerOwnsEmpty && filtering && <div role="status" className="record-views-empty" data-filtering={filtering}>
        <span>{filtering === 'failed' ? 'Filters could not be loaded.' : 'Applying filters…'}</span>
        {filtering === 'failed' && <Button variant="outline" size="sm" onClick={() => setFilterError(false)}>Retry filters</Button>}
      </div>}

      {showEmpty && (
        emptyContent != null ? <div className="record-views-empty-content">{emptyContent}</div> :
        searchHasWords ? <ScreenState state={{
          status: 'empty', icon: 'SearchX', title: emptyMessage,
          description: 'Try different words or clear the search.',
          action: {label: 'Clear search', run: () => callerSearch ? callerSearch.onCommit('') : changeSearch('')},
          ...(emptyAction ? {secondary: {label: emptyAction.label, run: emptyAction.onSelect}} : {}),
        }}/> :
        <div role="status" className="record-views-empty">
          <span>{ruleInForce && !filterRecords ? (filterError ? 'Filters could not be loaded.' : 'Applying filters…') : emptyMessage}</span>
          {ruleInForce && filterError && <Button variant="outline" size="sm" onClick={() => setFilterError(false)}>Retry filters</Button>}
          {emptyAction && <Button variant="outline" size="sm" onClick={emptyAction.onSelect}>{emptyAction.label}</Button>}
        </div>
      )}

      {visible.length > 0 && drawnHere === 'table' && (
        // Columns keep the width that makes their values readable, and the table
        // scrolls sideways when the sum of them outgrows the surface. Shrinking
        // every column to fit instead is how the last fields end up clipped to
        // nothing while the first ones sit half empty.
        <div className="record-views-scroll" ref={setTableHost} data-scrolled-sideways={scrolledSideways ? 'true' : undefined} onScroll={event => setScrolledSideways(event.currentTarget.scrollLeft > 0)}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead style={{width: '32px'}} data-frozen={frozenCount ? 'true' : undefined}>
                  <Checkbox
                    aria-label={`Select all ${label.toLowerCase()}`}
                    checked={visible.every(record => selected.has(identify(record)))}
                    onCheckedChange={checked => {
                      changeSelection(checked ? new Set(visible.map(identify)) : new Set<string>())
                      setSelectingEvery(Boolean(checked) && readsMore)
                    }}
                  />
                </TableHead>
                {shown.map(field => (
                  <TableHead key={field.id} {...columnPlace(field)} style={{width: `${widthFor(field)}px`, ...columnPlace(field).style}} data-sorted={sort?.fieldId === field.id ? sort.direction : undefined} aria-sort={field.sortable === false ? undefined : sort?.fieldId === field.id ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
                    <div className="record-views-head">
                      {field.sortable !== false ? (
                        <Button variant="ghost" size="sm" className="record-views-column-sort" aria-label={`Sort by ${field.label}`} aria-pressed={sort?.fieldId === field.id} onClick={() => toggleSort(field)}>
                          {field.icon && <NamedIcon name={field.icon} size="sm" className="record-views-column-icon" aria-hidden/>}
                          <span className="record-views-column-label">{field.label}</span>
                          {sort?.fieldId === field.id && <NamedIcon name={sort.direction === 'asc' ? 'arrow-up' : 'arrow-down'} size="xs" className="record-views-column-sorted" aria-hidden/>}
                        </Button>
                      ) : <span className="record-views-column-label">{field.label}</span>}
                      {columnMenu(field)}
                      <AutomationMarks automations={field.automations}/>
                    </div>
                    <TableColumnResizeHandle
                      width={widthFor(field)}
                      minWidth={64}
                      maxWidth={720}
                      step={16}
                      className="record-views-column-resize"
                      label={`Resize ${field.label} column`}
                      onResize={width => updateColumnWidth(field, width)}
                      onCommit={width => persistPreferences({columnWidths: {...columnWidths, [field.id]: width}})}
                    />
                  </TableHead>
                ))}
                {rowMenu && <TableHead data-row-actions="true" style={{width: '40px'}}/>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {tableFrom > 0 && (
                <TableRow aria-hidden="true" className="record-views-spacer-row">
                  <TableCell colSpan={shown.length + 1 + (rowMenu ? 1 : 0)} style={{height: table.offsets[tableFrom]}}/>
                </TableRow>
              )}
              {table.lines.slice(tableFrom, tableTo).map(line => {
                if (line.kind === 'heading') return (
                    <TableRow key={`heading:${line.block.node.key}`} className="record-views-divider-row" data-depth={line.block.node.depth}>
                      <TableCell colSpan={shown.length + 1 + (rowMenu ? 1 : 0)}>
                        <div className="record-views-cell">{sectionHeading(line.block.node, line.block.collapsed)}</div>
                      </TableCell>
                    </TableRow>
                  )
                  const record = line.record
                  const id = identify(record)
                  return withPreview(
                    <TableRow key={table.copies.get(id) === 1 ? `record:${id}` : `${line.key}:${id}`} data-record-id={id} data-share-record={shareRecord?.(record) ?? undefined} data-selected={selected.has(id) ? 'true' : 'false'} data-revealed={revealedId === id ? 'true' : undefined} data-arrived={arrived.has(id) ? 'true' : undefined} {...dragFor(id)} {...pointerFor(id)} onContextMenu={event => contextFor(event, id)}>
                      <TableCell data-frozen={frozenCount ? 'true' : undefined}>
                        <Checkbox
                          aria-label={`Select ${nameOf(record)}`}
                          checked={selected.has(id)}
                          onCheckedChange={(checked, details) => toggleOne(id, !!checked, details?.event)}
                        />
                      </TableCell>
                      {shown.map(field => (
                        <TableCell key={field.id} {...columnPlace(field)}>
                          {/* A table cell ignores max-height, so the row grows to
                              fit whatever the widest value wraps to and the grid
                              loses its rhythm. Twenty puts a fixed-height
                              container inside the cell for this reason. */}
                          <div className="record-views-cell">
                            <Mark field={field} record={record}/>
                            {/* The name opens the record, not whichever column
                                happens to be first. On a surface that leads with
                                a picture, first is the picture. */}
                            {field.editable && onEditFieldValue
                              ? <EditableCell
                                  field={field}
                                  record={record}
                                  recordId={id}
                                  countOf={countOf}
                                  onTagFilter={filterByTag}
                                  onCommit={value => onEditFieldValue(id, field.id, value)}
                                  onEditingChange={editing => cellEditing(id, field.id, editing)}
                                />
                              : field === naming && onOpen
                              ? <Button variant="ghost" size="sm" className="record-views-open-link" onClick={() => onOpen(id)}><Cell field={field} record={record} countOf={countOf} rules={rules} onTagFilter={filterByTag}/></Button>
                              : asked(field, record, <Cell field={field} record={record} countOf={countOf} rules={rules} onTagFilter={filterByTag}/>)}
                          </div>
                        </TableCell>
                      ))}
                      {rowMenu && (
                        <TableCell data-row-actions="true">
                          <div className="record-views-cell">
                            <RowActionMenu actions={rowActions} record={record} id={id} name={nameOf(record)} about={aboutOf(record)}/>
                          </div>
                        </TableCell>
                      )}
                    </TableRow>,
                    record, id, 'bottom',
                  )
                })}
              {tableTo < table.lines.length && (
                <TableRow aria-hidden="true" className="record-views-spacer-row">
                  <TableCell colSpan={shown.length + 1 + (rowMenu ? 1 : 0)} style={{height: table.offsets[table.lines.length]! - table.offsets[tableTo]!}}/>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {visible.length > 0 && drawnHere === 'board' && boardField && (
        <div className="record-views-board" ref={setBoardHost} data-detail={cardDetail?.id}>
          {boardColumns.map(({value: columnValue, label: columnLabel, range: columnRange, records: columnRecords}) => {
            const columnKey = JSON.stringify([boardField.id, columnValue])
            const folded = collapsedColumns.has(columnKey)
            const columnName = columnLabel || boardField.label
            const foldWord = (folded ? BOARD_WORDS.unfold : BOARD_WORDS.fold).replace('{column}', columnName)
            return (
              <div key={columnValue} className="record-views-board-column" data-collapsed={folded ? 'true' : undefined} aria-label={`${boardField.label} ${columnValue ? columnLabel : ''}`}>
              <div className="record-views-board-column-header" data-collapsed={folded ? 'true' : undefined}>
              {/* The count is a chip beside the name, never bare digits. */}
              {folded
                ? <span className="record-views-board-folded-label" title={BOARD_WORDS.folded_title.replace('{column}', columnLabel).replace('{count}', String(columnRecords.length)).replace('{item_word}', columnRecords.length === 1 ? BOARD_WORDS.item_one : BOARD_WORDS.item_many)}>{columnLabel}</span>
                : columnValue === '' ? <><span>{columnLabel}</span><CountChip variant="neutral" size="sm" className="record-views-count">{columnRecords.length.toLocaleString()}</CountChip></> : <Tag value={columnValue} field={boardField} count={columnRecords.length} active={tagActive(boardField, columnValue, columnRange)} onClick={boardField.filterable ? () => filterByTag(boardField, columnValue, columnRange) : undefined} displayLabel={columnLabel}/>}
              <Button type="button" variant="ghost" size="icon-sm" className="record-views-board-fold" aria-expanded={!folded}
                aria-label={foldWord} title={foldWord}
                onClick={() => toggleColumn(columnKey)}><NamedIcon name={folded ? 'ChevronRight' : 'ChevronLeft'} aria-hidden/></Button>
                </div>
                {!folded && <WindowedCards records={columnRecords} measureKey={cardDetail?.id ?? null} render={record => {
                  const id = identify(record)
                  return withPreview(
                    <article key={id} role="link" tabIndex={0} data-record-id={id} data-share-record={shareRecord?.(record) ?? undefined} data-selected={selected.has(id) ? 'true' : 'false'} data-revealed={revealedId === id ? 'true' : undefined} data-arrived={arrived.has(id) ? 'true' : undefined} {...dragFor(id)} {...pointerFor(id)} onKeyDown={event => {if(event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')){event.preventDefault();onOpen?.(id)}}} onContextMenu={event => contextFor(event, id)}>
                      {/* The column already names the value the board groups by, so the card leaves it out. */}
                      <RecordCardBody fields={shown.filter(field => field !== boardField)} record={record} countOf={countOf} rules={rules} onTagFilter={filterByTag} detail={cardDetail}/>
                      {rowMenu && (
                        <RowActionMenu actions={rowActions} record={record} id={id} name={nameOf(record)} about={aboutOf(record)} stopPropagation/>
                      )}
                    </article>,
                    record, id,
                  )
                }}/>
                }
              </div>
            )
          })}
        </div>
      )}

      {visible.length > 0 && drawnHere === 'gallery' && (
        <div
          ref={setGalleryHost}
          className="record-views-gallery-sections"
          data-windowed="true"
          data-timeline={timelineActive ? 'true' : undefined}
          data-detail={cardDetail?.id}
          style={{height: gallery.offsets[gallery.lines.length]! + 2 * galleryLook.inset, '--record-views-columns': columns, '--record-views-card-height': `${cardHeight}px`} as React.CSSProperties}
        >
          {gallery.lines.slice(galleryFrom, galleryTo).map((line, index) => {
            const top = {transform: `translateY(${gallery.offsets[galleryFrom + index]! + galleryLook.inset}px)`}
            if (line.kind === 'heading') return <h3 key={`heading:${line.block.node.key}`} className="record-views-section-heading" data-depth={line.block.node.depth} style={top}>{sectionHeading(line.block.node, line.block.collapsed)}</h3>
            return (
              <div key={line.key} className="record-views-gallery" data-depth={line.depth} style={top}>
                {line.records.map(record => {
                  const id = identify(record)
                  const picture = thumbnailFieldFor(shown, record)
                  const hasThumbnail = Boolean(picture)
                  const name = nameOf(record)
                  const bare = Boolean(timelineActive && zoomLevel?.picture_only && picture)
                  const card = (
                    <article
                      key={id}
                      data-record-id={id}
                      data-share-record={shareRecord?.(record) ?? undefined}
                      data-selected={selected.has(id) ? 'true' : 'false'}
                      data-revealed={revealedId === id ? 'true' : undefined}
                      data-arrived={arrived.has(id) ? 'true' : undefined}
                      className="record-views-gallery-card"
                      {...dragFor(id)}
                      {...pointerFor(id)}
                      role="link"
                      aria-label={hasThumbnail ? name : undefined}
                      title={hasThumbnail && !previewing.length ? name : undefined}
                      tabIndex={0}
                      onKeyDown={event => {if(event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')){event.preventDefault();onOpen?.(id)}}}
                      onContextMenu={event => contextFor(event, id)}
                    >
                      {!bare && <span className="record-views-card-corner">
                        <Checkbox
                          aria-label={`Select ${nameOf(record)}`}
                          checked={selected.has(id)}
                          onCheckedChange={(checked, details) => toggleOne(id, !!checked, details?.event)}
                        />
                        {rowMenu && (
                          <RowActionMenu actions={rowActions} record={record} id={id} name={nameOf(record)} about={aboutOf(record)}/>
                        )}
                      </span>}
                      <RecordCardBody fields={bare ? [picture!] : shown} record={record} countOf={countOf} rules={rules} onTagFilter={filterByTag} large detail={bare ? undefined : cardDetail}/>
                    </article>
                  )
                  // The name and every field the caller marks `preview` open
                  // in a hover card; with none marked, the card stands alone.
                  return bare ? card : withPreview(card, record, id)
                })}
              </div>
            )
          })}
        </div>
      )}

      {visible.length > 0 && drawnHere === 'sheet' && (
        // The same shown fields as the table, as a dense grid of cells. Picking
        // a cell picks its record, so the selection, the bulk actions and the
        // open action are the ones every other view uses.
        <React.Suspense fallback={<ScreenState state={{status: 'loading', label, layout: 'rows'}}/>}><SheetView
          label={label}
          columns={shown.map(field => ({id: field.id, label: field.label, width: widthFor(field), align: alignFor(field)}))}
          records={visible}
          identify={identify}
          selected={selected}
          onPickRecord={id => pick(id)}
          onOpen={onOpen}
          cellText={(fieldId, record) => asText(readField(byId.get(fieldId)!, record))}
          drawCell={(fieldId, record) => {
            const field = byId.get(fieldId)!
            return <><Mark field={field} record={record}/><Cell field={field} record={record} countOf={countOf} rules={rules} onTagFilter={filterByTag}/></>
          }}
        /></React.Suspense>
      )}

      {visible.length > 0 && drawnHere === 'changelog' && (
        <div className="record-views-changelog" aria-label={`${label} as a changelog`}>
          {[...visible].sort((left, right) => {
            const dated = shown.find(field => field.ruleKind === 'date' || field.kind === 'date')
            const at = (record: any) => dated ? Date.parse(asText(readField(dated, record))) || Number(dated.sortValue?.(record)) || 0 : 0
            return at(right) - at(left)
          }).map(record => {
            const id = identify(record)
            const dated = shown.find(field => field.ruleKind === 'date' || field.kind === 'date')
            const when = dated ? asText(readField(dated, record)) : ''
            const content = shown.filter(field => field !== naming && field !== dated && asText(readField(field, record)))
            return <article key={id} className="record-views-changelog-entry">
              <div className="record-views-changelog-date">{when}</div>
              <div className="record-views-changelog-content">
                {onOpen ? <Button variant="ghost" size="sm" onClick={() => onOpen(id)}>{nameOf(record)}</Button> : <strong>{nameOf(record)}</strong>}
                {content.map(field => <div key={field.id} className="record-views-changelog-field"><Cell field={field} record={record} countOf={countOf} rules={rules} onTagFilter={filterByTag}/></div>)}
              </div>
            </article>
          })}
        </div>
      )}

      {readsMore && <span ref={endMarker} className="record-views-end-marker" aria-hidden="true"/>}

      {/* One bar, only while a selection exists AND the caller has not brought
          its own. A caller with a richer action dock passes no bulkActions and
          keeps it; rendering both would put the same selection behind two
          competing sets of controls. */}
      {selectedIds.length > 0 && bulkActions.length > 0 && (
        <div className="record-views-selection-bar" role="toolbar" aria-label="Selected records">
          {asking ? <>
            <span className="record-views-selection-count" role="status">{asking.confirm}</span>
            <Button variant="default" size="sm" onClick={() => { setAskingId(null); asking.run(selectedIds) }}>{`Yes, ${asking.label.charAt(0).toLowerCase()}${asking.label.slice(1)}`}</Button>
            <Button variant="ghost" size="sm" onClick={() => setAskingId(null)}>Keep it</Button>
          </> : <>
            <span className="record-views-selection-count">{selectedIds.length} selected</span>
            {bulkActions.filter(action => !action.appliesTo || records.filter(record => selected.has(identify(record))).every(record => action.appliesTo!(record))).map(action => (
              <Button key={action.id} variant="outline" size="sm" onClick={() => (action.confirm ? setAskingId(action.id) : action.run(selectedIds))}>{action.label}</Button>
            ))}
            <Button variant="ghost" size="sm" onClick={() => changeSelection(new Set())}>Clear</Button>
          </>}
        </div>
      )}
    </section>
  )
}

// A board column's cards, drawn only where the column is on screen. Cards are
// measured once drawn (the distance from one to the next), and the cards above
// and below the visible stretch are spacer.
function WindowedCards({records, render, measureKey = null}: {records: any[]; render: (record: any) => React.ReactNode; measureKey?: unknown}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const seen = useScrollWindow(host, 900)
  const pitch = useMeasuredHeight(host, ':scope > article', 180, measureKey, true)
  const first = Math.min(records.length, Math.max(0, Math.floor(seen.top / pitch)))
  const last = Math.min(records.length, Math.max(first, Math.ceil(seen.bottom / pitch)))
  return (
    <div ref={setHost}>
      {first > 0 && <div aria-hidden="true" className="record-views-spacer" style={{height: first * pitch}}/>}
      {records.slice(first, last).map(render)}
      {last < records.length && <div aria-hidden="true" className="record-views-spacer" style={{height: (records.length - last) * pitch}}/>}
    </div>
  )
}

// One record's own menu, the same on a row, a board card and a gallery card.
// Each action row is DATA (label, icon name, tone, shortcut) drawn by the one
// shared ActionMenu.
// A row with `choices` opens them as a submenu on hover. Nested ids are keyed
// by their path so a choice can never collide with another row's id; the
// choices are read only while the menu is open.
// What the record is (`about`, from the caller's aboutRecord or its share reference) makes the menu offer every row the
// page has for it after the record's own actions (action-menu/menu-rows.ts).

/** Prefer an image file, then another file's real poster, then a declared thumbnail without a picture. */
export function thumbnailFieldFor(fields: FieldDescriptor[], record: any) {
  const thumbnails = fields.filter(field => field.kind === 'thumbnail')
  const pictures = thumbnails.filter(field => field.pictureUrl?.(record))
  return pictures.find(field => field.pictureSource?.(record) === 'image') ?? pictures[0] ?? thumbnails[0]
}

// A card is the same fields a row shows, stacked: the thumbnail if the caller
// declared one, then the identifying field, then the next few values as chips.
// Board and gallery differ in size, never in what they know.
function RecordCardBody({fields, record, countOf, rules, onTagFilter, large = false, detail}: {fields: FieldDescriptor[]; record: any; countOf: CountOf; rules: RuleGroup; onTagFilter: (field: FieldDescriptor, value: string) => void; large?: boolean; detail?: DetailLevel}) {
  const thumbnail = thumbnailFieldFor(fields, record)
  const rest = fields.filter(field => field !== thumbnail)
  // The detail level says how many fields follow the name (three when none is given) and whether a picture card
  // keeps its words under the picture.
  const told = rest.slice(1, detail?.fields === null ? undefined : 1 + (detail?.fields ?? 3))
  // A declared thumbnail can be an empty placeholder (for example a budget row has no merchant logo).
  // Only an actual picture may replace the words; otherwise the card still needs its name, facts and controls.
  const words = !large || !thumbnail?.pictureUrl?.(record) || Boolean(detail?.words_under_picture)
  const overlays = thumbnail ? fields.filter(field => (typeof field.cardOverlay === 'function' ? field.cardOverlay(record) : field.cardOverlay) && asText(readField(field, record)) !== '') : []
  return (
    <>
      {thumbnail && (
        <span className="record-views-card-thumbnail" data-large={large ? 'true' : 'false'}>
          <Cell field={thumbnail} record={record} countOf={countOf} rules={rules} onTagFilter={onTagFilter}/>
          {overlays.length > 0 && (
            <span className="record-views-card-overlay">
              {overlays.map(field => <Cell key={field.id} field={field} record={record} countOf={countOf} rules={rules} onTagFilter={onTagFilter}/>)}
            </span>
          )}
        </span>
      )}
      {words && <span className="record-views-card-title">{rest[0] && <Mark field={rest[0]} record={record}/>}<span className="record-views-card-title-text">{asText(readField(rest[0], record))}</span></span>}
      {words && told.length > 0 && <span className="record-views-card-fields">
        {/* Each value in its own box, so two plain values read as two ("80 KB", "Sep 25") rather than one run, led by its
            field's icon so the value needs no label (the label shows on hover and is read aloud). */}
        {told.map(field => <span key={field.id} className="record-views-card-field" title={field.label}>{field.icon ? <NamedIcon name={field.icon} size="xs" aria-hidden className="record-views-card-field-icon"/> : null}<span className="record-views-card-field-label">{field.label}: </span>{asked(field, record, <Cell field={field} record={record} countOf={countOf} rules={rules} onTagFilter={onTagFilter}/>)}</span>)}
      </span>}
    </>
  )
}

// One React root per container, for the whole life of that container. A caller's
// render function runs on every state change and hands us the same element each
// time; calling createRoot twice on one element makes React warn and paint
// nothing, which reads as a broken view rather than a double mount.
const hosts = new WeakMap<HTMLElement, {host: HTMLElement; root: ReturnType<typeof createRoot>}>()

export function mountRecordViews(container: HTMLElement, options: RecordViewsOptions) {
  let entry = hosts.get(container)
  if (!entry || !entry.host.isConnected) {
    // Before the container is emptied, not after: whoever held it last tears
    // itself down while the DOM still matches what it rendered.
    // Before the container is emptied, not after: whoever held it last tears
    // itself down while the DOM still matches what it rendered.
    releaseNode(container)
    container.replaceChildren()
    container.classList.add('coss-ui')
    // A container that normally lays its children out itself (a gallery grid, a
    // flex row) would make this whole surface one of its cells, which renders as
    // a narrow column with the rest of the page empty beside it. The marker lets
    // one stylesheet rule stop that for every view at once. Naming the views in
    // that rule instead is how a view added later silently breaks: the first
    // version of it listed table and board, and gallery came out crushed.
    container.dataset.recordViewsHost = 'true'
    const host = document.createElement('div')
    host.className = 'record-views-host'
    container.append(host)
    entry = {host, root: createRoot(host)}
    hosts.set(container, entry)
    // This container may already belong to another writer. Claiming it lets
    // that one unmount itself properly instead of having its children pulled
    // out from under it by the replaceChildren() above, which is what made the
    // next swap back throw on removeChild.
    claimNode(container, () => {
      const held = hosts.get(container)
      if (!held) return
      hosts.delete(container)
      held.root.unmount()
      held.host.remove()
      delete container.dataset.recordViewsHost
    })
  }
  // Plain render, never flushSync. A caller's render function is usually
  // reached from inside a React event on a shared control, and flushSync called
  // from within React's own batch throws, which leaves the host mounted and
  // empty: the surface reads as broken rather than as a scheduling mistake.
  const draw = (next: RecordViewsOptions) => {
    const ancestors: string[] = []
    for (let at: HTMLElement | null = container; at; at = at.parentElement) {
      const node = at.getAttribute('data-focus-node') ?? at.getAttribute('data-trillion-screen')
      if (node && !ancestors.includes(node)) ancestors.unshift(node)
    }
    const focusPath = next.focusPath ?? nodeRulePath(ancestors.filter(node => node !== 'app'), next.preferenceKey ?? `record-views:${next.label}:${next.fields.map(field => field.id).sort().join(',')}`)
    entry!.root.render(<RecordViews key={next.preferenceKey} {...next} focusPath={focusPath}/>)
  }
  draw(options)
  return {
    update: (next: Partial<RecordViewsOptions>) => draw({...options, ...next}),
    // One teardown path. The release registered at claim time already unmounts
    // the root, removes the host and drops the registry entry, so duplicating
    // it here is how the two drift apart.
    destroy: () => releaseNode(container),
  }
}
