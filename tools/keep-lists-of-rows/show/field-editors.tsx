// package-set://bitfield-studio/packages/visual-database/show/field-editors.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The shape-keyed field editor registry plus the descriptor-driven write path.
// ONE generic editor dispatch replaces every hand-built per-field pill: the
// value self-describes (deriveShape), the registry maps shape → editor, and
// every commit funnels through `writeField` — a deep-set along the
// descriptor's write path into the record's payload, written through the one
// engine write primitive.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Registry-first dispatch, exported for composition-level extension.
//    Unknown shape strings fall back to the text editor — degrade, never error.
// 2. Editors receive `commit` and target-identified owner capabilities. This
//    module imports no stateful owner implementation and performs no hidden I/O.
// 3. Records whose payload cannot root a write path (bare-value rows) resolve
//    to read-only rendering — one generic guard, no error.
// 4. No field names, no domain vocabulary: descriptors carry all meaning.
//
// =============================================================================

import React from 'react';
import { Check, Circle, ExternalLink, FolderOpen, Info, MoreHorizontal, Paperclip, Plus, X } from 'lucide-react';
import { LoadingMark } from 'trillion-workshop/tools/ui/show/loading-mark/index.ts';
import type { FileContentRendererClassification } from '../../file-content-renderer/show/FileContentRenderer';
import { later } from '../../ui/show/load-later/later';
import {
  classifyFileContent,
  fallbackFileContentClassification,
} from '../../file-content-renderer/show/classify-file-content';
import { Badge, Button, ColorDot, ColorTagPickerOverlay, CompletionRing, Container, Dropdown, Icon, InlineEditText, Input, MetricRow, PersonTag, Text, Textarea } from '../../ui';
import { DatePicker } from '../../ui/show/date-picker/DatePicker';
import type { ColorTagOption } from '../../ui';
import { OpenSurfaceAction } from '../../ui/show/open-surface-action';
import { recordSurfaceIntentToOpenSurfaceProps } from '../../ui/show/placeable-surface-intent/record-surface-intent';
import { buildRecordDeletion, buildRecordWrite, type FieldWrite } from 'trillion-workshop/tools/keep-lists-of-rows/do-work/record-write-builders.ts';
import type { RecordWriter } from 'trillion-workshop/tools/keep-lists-of-rows/do-work/record-writes.ts';
import type { VisualDatabaseActionContext as VisualDatabaseActionInvocation } from 'trillion-workshop/tools/keep-lists-of-rows/do-work/visual-database-actions.ts';
import {
  EMPTY_LANE_ID,
  deriveShape,
  effectiveDomain,
  extractFieldValue,
  isMachineToken,
  optionsFromRecords,
  recordAddress,
  recordPayload,
  recordGroupValues,
  readAttachmentRefs,
  syntheticFieldDescriptor,
  type VisualDatabaseActionDescriptor,
  type VisualDatabaseAttachmentRef,
  type VisualDatabaseFieldDescriptor,
  type VisualDatabaseFieldDomainValue,
  type VisualDatabaseLaneDescriptor,
  type VisualDatabaseModel,
  type VisualDatabaseRecord,
  type VisualDatabaseViewDescriptor,
} from 'trillion-workshop/tools/keep-lists-of-rows/read-data/visual-database.ts';
import {
  domainValueColor,
  humanize,
  stop,
  type FieldEditorComponent,
  type FieldEditorOwnerCapabilities,
  type FieldEditorProps,
} from 'trillion-workshop/tools/keep-lists-of-rows/show/field-editor-kit.ts';

// What a record shows only once opened arrives then (load-later): its notes' block editor and an attachment's reader.
const NotesDocument = later(() => import('./notes-document'), module => module.NotesDocument);
const FileContentRenderer = later(() => import('../../file-content-renderer/show/FileContentRenderer'), module => module.FileContentRenderer);
import { GridFieldEditor, ScaleFieldEditor } from './rating-editors';
import { FloatingPanel } from '../../screen-arrangement/show/FloatingPanel';

// The editor contract + shared pure helpers live in the leaf kit; re-export the
// contract types so existing consumers keep importing them from here.
export type { FieldEditorComponent, FieldEditorProps } from 'trillion-workshop/tools/keep-lists-of-rows/show/field-editor-kit.ts';
// `toneColor` moved to the leaf kit; re-export it so facade consumers
// (e.g. VisualDatabaseSurface) keep resolving it from here.
export { toneColor } from 'trillion-workshop/tools/keep-lists-of-rows/show/field-editor-kit.ts';

const FieldEditorOwnerCapabilitiesContext = React.createContext<FieldEditorOwnerCapabilities>({});

/** Composition-root boundary for stateful field-editor capabilities. Each
 * capability carries its opaque owner target; this package never imports or
 * names the implementation package behind that target. */
export function FieldEditorOwnerCapabilitiesProvider({
  value,
  children,
}: {
  value?: FieldEditorOwnerCapabilities;
  children: React.ReactNode;
}) {
  return (
    <FieldEditorOwnerCapabilitiesContext.Provider value={value ?? {}}>
      {children}
    </FieldEditorOwnerCapabilitiesContext.Provider>
  );
}

// -----------------------------------------------------------------------------
// Display helpers
// -----------------------------------------------------------------------------

export function isMachineString(value: string): boolean {
  return isMachineToken(value) || value.includes('::');
}

export function displayTitle(record: VisualDatabaseRecord): string {
  const title = record.title;
  if (title.includes('::')) {
    const parts = title.split('::').filter(Boolean);
    return parts.slice(-2).map(humanize).join(' · ');
  }
  if (isMachineToken(title)) {
    return `${humanize(record.kind)} · ${title.slice(0, 8)}`;
  }
  return title;
}

export function displaySubtitle(record: VisualDatabaseRecord): string {
  if (record.body) return record.body;
  if (isMachineString(record.title)) return record.title;
  return '';
}

export function shortDate(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return value;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(match[2]) - 1]} ${Number(match[3])}`;
}

function fieldMenuLabel(descriptor: VisualDatabaseFieldDescriptor): string {
  const label = humanize(descriptor.label);
  if (!label) return humanize(descriptor.id);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function humanizePerson(value: string): string {
  const withoutPrefix = value.replace(/^[a-z][a-z0-9_-]*:/i, '');
  const parts = withoutPrefix.includes('::')
    ? withoutPrefix.split('::').filter(Boolean)
    : [withoutPrefix];
  const best = [...parts].reverse().find((part) => /[a-z]/i.test(part) && !/^1f[a-z0-9]+$/i.test(part))
    ?? withoutPrefix;
  return humanize(best) || value;
}

function isEmptyPeopleValue(value: string): boolean {
  return /^(unassigned|un-assigned|none|no-assignee|not-assigned)$/i.test(value.trim());
}

type BadgeTone = 'neutral' | 'success' | 'warning' | 'error' | 'info' | 'accent' | 'muted';

const BADGE_TONES: readonly BadgeTone[] = ['neutral', 'success', 'warning', 'error', 'info', 'accent', 'muted'];

/** Open tone string → ui Badge variant; unknown tones degrade to neutral. */
export function toneVariant(tone: string | undefined): BadgeTone {
  return (BADGE_TONES as readonly string[]).includes(tone ?? '') ? (tone as BadgeTone) : 'neutral';
}

type StatusDotStatus = 'success' | 'warning' | 'error' | 'info' | 'accent' | 'idle';

const STATUS_DOT_STATUSES: readonly StatusDotStatus[] = ['success', 'warning', 'error', 'info', 'accent', 'idle'];

/** Open tone string → ui StatusDot status; unknown/neutral tones degrade to
 *  idle. The single home for the tone → status-dot mapping (any board surface
 *  that paints a domain option's status dot reads its tone through this). */
export function toneToStatusDot(tone: string | undefined): StatusDotStatus {
  return (STATUS_DOT_STATUSES as readonly string[]).includes(tone ?? '') ? (tone as StatusDotStatus) : 'idle';
}

/** The status-dot signal for a record: its value of the status field, resolved
 *  to that field's domain OPTION, mapped to a StatusDot status + an `active`
 *  (in-flight) flag — ALL from descriptor DATA. The single home for the
 *  "leading status dot" lookup every surface needs, so no surface re-implements
 *  it (L063). The status field is found by an explicit `fieldId`, else by the
 *  open `role: 'status'` binding; a model with no such field returns null (no
 *  dot). Unknown values resolve to an ad-hoc neutral option (an invented status
 *  renders as a quiet idle dot, zero code change). `active` comes from the
 *  option's data `pulse` flag — the option declares "this is a working state",
 *  the surface never infers it from the value. */
export function statusTone(
  record: VisualDatabaseRecord,
  model: VisualDatabaseModel,
  fieldId?: string,
): { status: StatusDotStatus; color: string; active: boolean } | null {
  const field = fieldId
    ? model.fields.find((candidate) => candidate.id === fieldId)
    : model.fields.find((candidate) => candidate.role === 'status');
  if (!field) return null;
  const value = String(extractFieldValue(record, field) ?? '');
  if (!value) return null;
  const option = effectiveDomain(field, model).find((candidate) => candidate.id === value);
  return {
    status: toneToStatusDot(option?.tone),
    color: domainValueColor(option),
    active: option?.pulse === true,
  };
}


// -----------------------------------------------------------------------------
// The descriptor-driven write path
//
// Write ASSEMBLY (descriptor + value → payload) and undo now live in the write
// owner: `do-work/record-writes.ts` (RB-BE-002). The UI imports those — it does
// NOT own record write meaning. Only UI-coupled wrappers remain here.
// -----------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function canEditRecord(record: VisualDatabaseRecord): boolean {
  return recordAddress(record) !== null && recordPayload(record) !== null;
}

/** THE one mutation every editor commits through. Success surfaces through
 *  the mutation notifier (toast) — silent saves read as broken saves. */
export async function writeField(
  write: RecordWriter,
  record: VisualDatabaseRecord,
  writes: readonly FieldWrite[],
): Promise<void> {
  const entry = buildRecordWrite(record, writes);
  if (entry) {
    await write(entry);
    reportSuccess('Saved');
  }
}

// -----------------------------------------------------------------------------
// Editor archetypes — one per value shape, ui primitives only
// -----------------------------------------------------------------------------

function dropdownRow(label: string, selected: boolean) {
  return (
    <Container layout="horizontal" justifyContent="between" alignItems="center" gap="md" padding="none" flex="1">
      <Text variant="body-xs" color={selected ? 'strong' : 'muted'}>{label}</Text>
      {selected ? <Icon icon={Check} size="xs" /> : null}
    </Container>
  );
}

function TextFieldEditor({ record, descriptor, value, commit, readOnly }: FieldEditorProps) {
  const text = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  const isTitle = descriptor.role === 'title';
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState('');

  if (editing && !readOnly) {
    return (
      <Input
        aria-label={descriptor.label}
        value={draft}
        borderless
        autoFocus
        placeholder={descriptor.label}
        onClick={stop}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={() => {
          const next = draft.trim();
          setEditing(false);
          if (next !== text.trim()) commit(next.length > 0 ? next : null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') { setDraft(text); setEditing(false); }
        }}
      />
    );
  }
  const beginEdit = readOnly ? undefined : (event: React.MouseEvent) => {
    event.stopPropagation();
    setDraft(text);
    setEditing(true);
  };
  if (!text) {
    if (readOnly) return null;
    return (
      <Button variant="ghost" size="xs" aria-label={descriptor.label} onClick={beginEdit}>
        <Text variant="caption" color="faint">—</Text>
      </Button>
    );
  }
  return (
    <Text
      variant="body-xs"
      color={isTitle ? 'strong' : 'muted'}
      truncate={isTitle}
      onClick={beginEdit}
    >
      {isTitle ? displayTitle(record) : text}
    </Text>
  );
}

function NumberFieldEditor(props: FieldEditorProps) {
  const { commit } = props;
  return (
    <TextFieldEditor
      {...props}
      commit={(next) => {
        if (next === null) { commit(null); return; }
        const parsed = Number(next);
        if (Number.isFinite(parsed)) commit(parsed);
      }}
    />
  );
}

function FlagFieldEditor({ descriptor, value, commit, readOnly }: FieldEditorProps) {
  const on = value === true;
  if (readOnly && !on) return null;
  return (
    <Button
      variant="ghost"
      size="xs"
      aria-label={descriptor.label}
      disabled={readOnly}
      onClick={(event: React.MouseEvent) => { event.stopPropagation(); commit(!on); }}
    >
      <Icon icon={on ? Check : Circle} size="xs" />
      <Badge variant={on ? 'success' : 'muted'}>{descriptor.label}</Badge>
    </Button>
  );
}

function ChoiceFieldEditor({ descriptor, value, domain, commit, readOnly }: FieldEditorProps) {
  const stored = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  // Optimistic: the chip flips the INSTANT the user picks — a toast saying
  // Saved while the chip still shows the old value reads as a lie. Stored
  // value arriving via the feed clears the optimistic overlay.
  const [optimistic, setOptimistic] = React.useState<string | null>(null);
  React.useEffect(() => { setOptimistic(null); }, [stored]);
  const current = optimistic ?? stored;
  const entry = domain.find((candidate) => candidate.id === current);
  // Linear status anatomy: tone-colored DOT + quiet text on the standard
  // chip surface — never tone-colored text floating bare (the orange-text
  // misread). Tone stays data; the dot carries it.
  const face = current
    ? (
      <Badge variant="muted">
        <ColorDot color={domainValueColor(entry)} size="xs" />
        {humanize(entry?.label ?? current)}
      </Badge>
    )
    : <Text variant="caption" color="faint">—</Text>;
  if (readOnly) return current ? face : null;
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const pickerIdentity = React.useId();
  const triggerId = `${pickerIdentity}-trigger`;
  const listboxId = `${pickerIdentity}-listbox`;

  const pickerOptions: ColorTagOption[] = domain.map((candidate) => ({
    id: candidate.id,
    label: humanize(candidate.label),
    color: domainValueColor(candidate),
  }));
  const restorePickerOriginFocus = React.useCallback(() => {
    const trigger = triggerRef.current;
    const gridcell = trigger?.closest<HTMLElement>('[role="gridcell"]') ?? null;
    (gridcell ?? trigger)?.focus({ preventScroll: true });
  }, []);
  const closePicker = React.useCallback(() => {
    setPickerOpen(false);
    restorePickerOriginFocus();
  }, [restorePickerOriginFocus]);
  const openPicker = React.useCallback(() => {
    setPickerOpen(true);
  }, []);

  return (
    <>
      <Button
        ref={triggerRef}
        id={triggerId}
        variant="ghost"
        size="sm"
        onClick={(event: React.MouseEvent) => {
          event.stopPropagation();
          if (pickerOpen) closePicker();
          else openPicker();
        }}
        onKeyDown={(event: React.KeyboardEvent) => {
          if (
            event.key !== 'Enter'
            && event.key !== ' '
            && event.key !== 'ArrowDown'
            && event.key !== 'ArrowUp'
          ) return;
          event.preventDefault();
          event.stopPropagation();
          openPicker();
        }}
        aria-label={descriptor.label}
        aria-haspopup="listbox"
        aria-expanded={pickerOpen}
        aria-controls={listboxId}
      >
        {face}
      </Button>

      <ColorTagPickerOverlay
        anchorRef={triggerRef}
        id={listboxId}
        labelledBy={triggerId}
        open={pickerOpen}
        onDismiss={closePicker}
        options={pickerOptions}
        selectedId={current || undefined}
        onSelect={(optionId) => {
          setOptimistic(optionId);
          closePicker();
          commit(optionId);
        }}
        label={descriptor.label}
        showDelete={false}
      />
    </>
  );
}

// -----------------------------------------------------------------------------
// Action prompt flow — fully data-defined invoke dialog
// -----------------------------------------------------------------------------

/** One modal renders ANY action's declared prompts: choice prompts (options
 *  filters → feed records) and free-text prompts, then fires the action with
 *  the answers + the value the action was invoked on. Zero per-action code. */
export const VisualDatabaseActionContext = React.createContext<((action: VisualDatabaseActionDescriptor, context: VisualDatabaseActionInvocation) => void | Promise<unknown>) | null>(null);

function useVisualDatabaseAction() {
  const invoke = React.useContext(VisualDatabaseActionContext);
  return React.useCallback(async (action: VisualDatabaseActionDescriptor, context: VisualDatabaseActionInvocation) => {
    if (!invoke) throw new Error('This surface has no action owner.');
    return invoke(action, context);
  }, [invoke]);
}

export function ActionPromptModal({ action, record, value, selectedRecords, model, onClose, onSubmit }: {
  action: VisualDatabaseActionDescriptor;
  record: VisualDatabaseRecord;
  value?: string;
  selectedRecords?: readonly VisualDatabaseRecord[];
  model: VisualDatabaseModel;
  onClose: () => void;
  onSubmit?: (answers: Readonly<Record<string, string>>) => void | Promise<unknown>;
}) {
  const invokeVisualDatabaseAction = useVisualDatabaseAction();
  const [answers, setAnswers] = React.useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = React.useState(false);
  const ready = action.inputPrompts.every((prompt) => (
    prompt.optional || (answers[prompt.key] ?? '').trim() !== ''
  ));
  const run = () => {
    if (busy) return;
    setBusy(true);
    const filled = Object.fromEntries(Object.entries(answers).filter(([, entry]) => entry !== ''));
    Promise.resolve(onSubmit
      ? onSubmit(filled)
      : invokeVisualDatabaseAction(action, { record, selectedRecords, value, answers: filled }))
      .then(() => { reportSuccess(action.label); onClose(); })
      .catch(reportFailure(action.label.toLowerCase()))
      .finally(() => setBusy(false));
  };
  return (
    <FloatingPanel open onClose={onClose} label="Edit field" width={384}>
      <Container layout="vertical" gap="md">
        <Container layout="vertical" gap="xs">
          <Text variant="heading-md">{action.label}</Text>
          <Text variant="body-xs" color="muted">{displayTitle(record)}</Text>
        </Container>
        {action.inputPrompts.map((prompt) => {
          const options = prompt.options ? optionsFromRecords(prompt.options, model.records, model.fields) : null;
          if (options) {
            const chosen = options.find((option) => (option.ref ?? option.id) === answers[prompt.key]);
            return (
              <Container key={prompt.key} layout="vertical" gap="xs">
                <Text variant="label" color="faint">{prompt.label}</Text>
                <Dropdown
                  aria-label={prompt.label}
                  items={[
                    ...(prompt.optional ? [{ value: '', label: `No ${prompt.label.toLowerCase()}` }] : []),
                    ...options.map((option) => ({ value: option.ref ?? option.id, label: option.label })),
                  ]}
                  value={answers[prompt.key] ?? ''}
                  align="start"
                  scrollable
                  customTrigger={(
                    <Badge variant={chosen ? 'neutral' : 'muted'} interactive>
                      {chosen ? chosen.label : prompt.label}
                    </Badge>
                  )}
                  renderItem={(item, state) => dropdownRow(item.label, state.selected)}
                  onValueChange={(next) => setAnswers((current) => ({ ...current, [prompt.key]: next }))}
                />
              </Container>
            );
          }
          return (
            <Container key={prompt.key} layout="vertical" gap="xs">
              <Text variant="label" color="faint">{prompt.label}</Text>
              <Textarea
                aria-label={prompt.label}
                rows={2}
                value={answers[prompt.key] ?? ''}
                placeholder={prompt.label}
                onChange={(event) => {
                  const next = event.target.value;
                  setAnswers((current) => ({ ...current, [prompt.key]: next }));
                }}
              />
            </Container>
          );
        })}
        <Container layout="horizontal" gap="sm" justifyContent="end">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" disabled={!ready || busy} onClick={run}>
            {busy ? 'Sending…' : action.label}
          </Button>
        </Container>
      </Container>
    </FloatingPanel>
  );
}

function MultiFieldEditor({ record, descriptor, value, domain, commit, readOnly, fieldActions, model }: FieldEditorProps) {
  const invokeVisualDatabaseAction = useVisualDatabaseAction();
  const isPeopleField = descriptor.role === 'badge' && descriptor.shape === 'multi';
  const rawValues = Array.isArray(value)
    ? value.map((entry) => String(entry))
    : typeof value === 'string' && value.length > 0 ? [value] : [];
  const values = isPeopleField ? rawValues.filter((entry) => !isEmptyPeopleValue(entry)) : rawValues;
  // A stored value may be the option's id OR its durable ref (assignees
  // store the agent record's address). Resolve the human label through
  // either key — a raw machine address must never render as chip text.
  const optionOf = (entry: string) => domain.find((candidate) => candidate.id === entry || candidate.ref === entry);
  const detailsOf = (entry: string) => optionOf(entry)?.details ?? [];
  const labelOf = (entry: string) => {
    const label = optionOf(entry)?.label ?? entry;
    return isPeopleField ? humanizePerson(label) : humanize(label);
  };
  // Pending action prompt flow: which action, on which chosen value.
  const [prompting, setPrompting] = React.useState<{ action: VisualDatabaseActionDescriptor; value: string } | null>(null);
  const actions = fieldActions ?? [];
  const remove = (entry: string) => {
    const next = values.filter((candidate) => candidate !== entry);
    commit(next.length > 0 ? next : null);
  };
  const known = new Set(values);
  const addItems = domain
    .filter((candidate) => !known.has(candidate.id))
    .map((candidate) => ({
      value: candidate.id,
      label: isPeopleField ? humanizePerson(candidate.label) : humanize(candidate.label),
    }));
  // Each chosen value renders as its OWN chip: click opens that value's menu
  // (remove + every data-declared field action). Read-only renders chips only.
  const chips = values.map((entry) => {
    const details = detailsOf(entry);
    const detailRow = details.length > 0
      ? (
          <MetricRow
            align="start"
            cells={details.map((detail) => ({ label: detail.label, value: detail.value }))}
          />
        )
      : null;
    if (isPeopleField) {
      const label = labelOf(entry);
      if (readOnly) {
        return (
          <Container key={entry} layout="vertical" gap="xs" padding="none" minHeight="0">
            <PersonTag name={label} />
            {detailRow}
          </Container>
        );
      }
      const ref = optionOf(entry)?.ref ?? entry;
      return (
        <Container key={entry} layout="vertical" gap="xs" padding="none" minHeight="0">
          <Dropdown
            aria-label={label}
            items={[
              ...actions.map((action) => ({ value: `act:${action.id}`, label: action.label, icon: action.icon })),
              ...addItems.map((item) => ({ value: `add:${item.value}`, label: `Add ${item.label}`, icon: 'plus' })),
              { value: 'remove', label: 'Remove', icon: 'x' },
            ]}
            value=""
            align="start"
            customTrigger={(
              <Button variant="plain" size="icon-xs" aria-label={label} onClick={stop}>
                <PersonTag name={label} />
              </Button>
            )}
            onValueChange={(picked) => {
              if (picked.startsWith('add:')) {
                const next = picked.slice(4);
                if (next && !values.includes(next)) commit([...values, next]);
                return;
              }
              if (picked === 'remove') { remove(entry); return; }
              const action = actions.find((candidate) => `act:${candidate.id}` === picked);
              if (!action || !model) return;
              if (action.inputPrompts.length > 0) setPrompting({ action, value: ref });
              else {
                invokeVisualDatabaseAction(action, { record, value: ref })
                  .then(() => reportSuccess(action.label))
                  .catch(reportFailure(action.label.toLowerCase()));
              }
            }}
          />
          {detailRow}
        </Container>
      );
    }
    const option = optionOf(entry);
    const chip = (
      <Badge key={entry} variant="muted">
        <ColorDot color={domainValueColor(option)} size="xs" />
        {labelOf(entry)}
      </Badge>
    );
    if (readOnly) {
      return (
        <Container key={entry} layout="vertical" gap="xs" padding="none" minHeight="0">
          {chip}
          {detailRow}
        </Container>
      );
    }
    const ref = optionOf(entry)?.ref ?? entry;
    return (
      <Container key={entry} layout="vertical" gap="xs" padding="none" minHeight="0">
        <Dropdown
          aria-label={labelOf(entry)}
          items={[
            ...actions.map((action) => ({ value: `act:${action.id}`, label: action.label, icon: action.icon })),
            { value: 'remove', label: 'Remove', icon: 'x' },
          ]}
          value=""
          align="start"
          customTrigger={React.cloneElement(chip, { interactive: true, onClick: stop })}
          onValueChange={(picked) => {
            if (picked === 'remove') { remove(entry); return; }
            const action = actions.find((candidate) => `act:${candidate.id}` === picked);
            if (!action || !model) return;
            if (action.inputPrompts.length > 0) setPrompting({ action, value: ref });
            else {
              invokeVisualDatabaseAction(action, { record, value: ref })
                .then(() => reportSuccess(action.label))
                .catch(reportFailure(action.label.toLowerCase()));
            }
          }}
        />
        {detailRow}
      </Container>
    );
  });
  const addFace = values.length > 0
    ? <Badge variant="muted" interactive aria-label={`Add ${descriptor.label.toLowerCase()}`}><Icon icon={Plus} size="xs" /></Badge>
    : <Text variant="caption" color="faint">—</Text>;
  if (readOnly) {
    return values.length > 0
      ? <Container layout="horizontal" gap="xs" padding="none" alignItems="center" wrap="wrap">{chips}</Container>
      : null;
  }
  return (
    <Container layout="horizontal" gap="xs" padding="none" alignItems="center" wrap="wrap" onClick={stop}>
      {chips}
      {isPeopleField && values.length > 0 ? null : (
        <Dropdown
        aria-label={`Add ${descriptor.label.toLowerCase()}`}
        items={addItems}
        value=""
        align="start"
        scrollable
        customTrigger={addFace}
        renderItem={(item) => dropdownRow(item.label, false)}
        // The open door (domain.open): any name typed here joins the value
        // set verbatim — options are suggestions, never a cap.
        footer={descriptor.domain?.open ? (
          <Container layout="horizontal" padding="none" minHeight="0" onClick={stop}>
            <InlineEditText
              aria-label={`New ${descriptor.label.toLowerCase()}`}
              value=""
              variant="body-xs"
              placeholder="Type a name…"
              onCommit={(typed) => {
                const trimmed = typed.trim();
                if (trimmed && !values.includes(trimmed)) commit([...values, trimmed]);
              }}
            />
          </Container>
        ) : undefined}
        onValueChange={(toggled) => {
          if (toggled && !values.includes(toggled)) commit([...values, toggled]);
        }}
        />
      )}
      {prompting && model ? (
        <ActionPromptModal
          action={prompting.action}
          record={record}
          value={prompting.value}
          model={model}
          onClose={() => setPrompting(null)}
        />
      ) : null}
    </Container>
  );
}

function TemporalFieldEditor({ descriptor, value, commit, readOnly }: FieldEditorProps) {
  const iso = typeof value === 'string' ? value : null;
  const label = shortDate(iso);
  // Linear/Amie date metadata is quiet gray, never accent-colored.
  const face = label
    ? <Badge variant="muted">{label}</Badge>
    : <Text variant="caption" color="faint">—</Text>;
  if (readOnly) return label ? face : null;
  return (
    <DatePicker
      aria-label={descriptor.label}
      value={iso}
      onChange={(next) => commit(next)}
      // The badge IS the trigger — wrapping it in a padded button produced
      // a pill-inside-a-pill. Popover attaches interaction via asChild.
      trigger={React.cloneElement(face, { onClick: stop })}
    />
  );
}

function ReferenceFieldEditor(props: FieldEditorProps) {
  if (Array.isArray(props.value)) return <MultiFieldEditor {...props} />;
  const { descriptor, value, domain, commit, readOnly } = props;
  const current = typeof value === 'string' ? value : '';
  const entry = domain.find((candidate) => candidate.id === current);
  const face = current
    ? <Badge variant="accent">{humanize(entry?.label ?? current)}</Badge>
    : <Text variant="caption" color="faint">—</Text>;
  if (readOnly) return current ? face : null;
  const items = [
    { value: '', label: `No ${descriptor.label.toLowerCase()}` },
    ...domain.map((candidate) => ({ value: candidate.id, label: candidate.label })),
  ];
  return (
    <Dropdown
      aria-label={descriptor.label}
      items={items}
      value={current}
      align="start"
      scrollable
      customTrigger={React.cloneElement(face, { onClick: stop })}
      renderItem={(item, state) => dropdownRow(item.label, state.selected)}
      onValueChange={(next) => {
        if (next !== current) commit(next.length > 0 ? next : null);
      }}
    />
  );
}

function basename(value: string): string {
  const cleaned = value.replace(/\\/g, '/').replace(/\/+$/g, '');
  const parts = cleaned.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? value;
}

function attachmentFromText(value: string): unknown | null {
  const text = value.trim();
  if (!text) return null;
  if (/^(\/|~\/|\.\.?\/)/.test(text)) return { kind: 'file', file_path: text, label: basename(text) };
  if (/^https?:\/\//i.test(text)) return { kind: 'url', url: text, label: text };
  if (/^(1f:|1f20)/i.test(text) || text.includes('::')) return { kind: 'log-ref', address: text, label: text };
  return { kind: 'ref', ref: text, label: text };
}

function attachmentRawValue(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  return value === null || value === undefined ? [] : [value];
}

type AttachmentPreviewState =
  | { status: 'idle' }
  | { status: 'loading'; label: string }
  | { status: 'error'; label: string; message: string }
  | {
      status: 'ready';
      label: string;
      filePath: string;
      content?: string;
      bytes?: Uint8Array;
      classification: FileContentRendererClassification;
      source?: string;
      url?: string;
      showFileActions?: boolean;
    };

function attachmentReference(attachment: VisualDatabaseAttachmentRef): string {
  return attachment.filePath
    ?? attachment.url
    ?? attachment.address
    ?? attachment.contentAddress
    ?? attachment.label;
}

function attachmentFilePath(attachment: VisualDatabaseAttachmentRef): string {
  return attachment.filePath ?? attachment.label;
}

function textAt(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

/** A record with no words of its own is handed to the preview as JSON data, which the file preview reads through the
 *  shared value view (fields, lists, cards), never as text. */
function recordData(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function recordForAttachment(
  attachment: VisualDatabaseAttachmentRef,
  model: VisualDatabaseModel | undefined,
): VisualDatabaseRecord | null {
  const target = attachment.address ?? attachment.contentAddress;
  if (!target || !model) return null;
  return model.records.find((record) => (
    recordAddress(record) === target
    || record.id === target
    || record.title === target
  )) ?? null;
}

function contentFromAttachedRecord(record: VisualDatabaseRecord): { content: string; filePath: string; mimeType?: string } {
  const raw = isPlainObject(record.raw) ? record.raw : {};
  const payload = isPlainObject(raw.payload) ? raw.payload : raw;
  const words = textAt(payload, ['content', 'markdown', 'text', 'body', 'payload_text'])
    ?? textAt(raw, ['content', 'markdown', 'text', 'body', 'payload_text']);
  const content = words ?? recordData(payload);
  const filePath = textAt(payload, ['file_path', 'filePath', 'path', 'name', 'title'])
    ?? textAt(raw, ['file_path', 'filePath', 'path', 'name', 'title'])
    ?? displayTitle(record);
  const mimeType = textAt(payload, ['mime_type', 'mimeType', 'content_type', 'contentType'])
    ?? textAt(raw, ['mime_type', 'mimeType', 'content_type', 'contentType'])
    ?? (words === null ? 'application/json' : undefined);
  return { content, filePath, mimeType };
}

async function resolveAttachmentPreview(
  attachment: VisualDatabaseAttachmentRef,
  model: VisualDatabaseModel | undefined,
  ownerCapabilities: FieldEditorOwnerCapabilities,
): Promise<AttachmentPreviewState> {
  if (attachment.content) {
    const filePath = attachmentFilePath(attachment);
    return {
      status: 'ready',
      label: attachment.label,
      filePath,
      content: attachment.content,
      classification: fallbackFileContentClassification(filePath, attachment.mimeType),
      source: attachment.source,
      url: attachment.url,
    };
  }

  const attachedRecord = recordForAttachment(attachment, model);
  if (attachedRecord) {
    const material = contentFromAttachedRecord(attachedRecord);
    return {
      status: 'ready',
      label: attachment.label,
      filePath: material.filePath,
      content: material.content,
      classification: fallbackFileContentClassification(material.filePath, material.mimeType),
      source: displayTitle(attachedRecord),
    };
  }

  if (attachment.filePath) {
    const read = ownerCapabilities.attachment?.read;
    if (!read) {
      return {
        status: 'error',
        label: attachment.label,
        message: 'This file preview has no admitted owner capability.',
      };
    }
    try {
      const file = await read.invoke(read.target, { path: attachment.filePath });
      const classification = await classifyFileContent(file.path, file.contentType);
      const content = classification.renderer === 'image'
        ? ''
        : new TextDecoder().decode(file.bytes ?? new Uint8Array());
      return {
        status: 'ready',
        label: attachment.label,
        filePath: file.path,
        content,
        bytes: file.bytes,
        classification,
        source: file.contentType,
        showFileActions: true,
      };
    } catch (error) {
      return {
        status: 'error',
        label: attachment.label,
        message: 'The attachment owner could not read this preview.',
      };
    }
  }

  if (attachment.url) {
    return {
      status: 'ready',
      label: attachment.label,
      filePath: attachment.url,
      content: '',
      classification: fallbackFileContentClassification(attachment.url, attachment.mimeType),
      url: attachment.url,
      source: 'Link',
    };
  }

  return {
    status: 'ready',
    label: attachment.label,
    filePath: attachment.label,
    content: attachmentReference(attachment),
    classification: fallbackFileContentClassification(attachment.label, attachment.mimeType),
    source: 'Reference',
  };
}

function openAttachment(attachment: VisualDatabaseAttachmentRef): void {
  if (attachment.url && typeof window !== 'undefined') {
    window.open(attachment.url, '_blank', 'noopener,noreferrer');
  }
}

function copyAttachment(attachment: VisualDatabaseAttachmentRef): void {
  void navigator.clipboard?.writeText(attachmentReference(attachment)).catch(() => {});
}

function AttachmentPreviewPanel({
  attachment,
  model,
  ownerCapabilities,
  onClose,
}: {
  attachment: VisualDatabaseAttachmentRef;
  model?: VisualDatabaseModel;
  ownerCapabilities: FieldEditorOwnerCapabilities;
  onClose: () => void;
}) {
  const [state, setState] = React.useState<AttachmentPreviewState>({ status: 'idle' });

  React.useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading', label: attachment.label });
    resolveAttachmentPreview(attachment, model, ownerCapabilities).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [attachment, model, ownerCapabilities]);

  const reveal = ownerCapabilities.attachment?.reveal;
  const editor = ownerCapabilities.attachment?.editor;

  return (
    <Container
      layout="vertical"
      gap="xs"
      padding="sm"
      minWidth="0"
      style={{ borderRadius: 8, background: 'var(--glass-bg-subtle)', border: '1px solid var(--border-primary)' }}
    >
      <Container layout="horizontal" justifyContent="between" alignItems="center" gap="sm" padding="none" minHeight="0">
        <Container layout="vertical" gap="none" padding="none" minWidth="0">
          <Text variant="body-xs" color="strong">{state.status === 'idle' ? attachment.label : state.label}</Text>
        </Container>
        <Container layout="horizontal" gap="xs" padding="none" minHeight="0" alignItems="center">
          {attachment.url ? (
            <Button variant="ghost" size="xs" onClick={() => openAttachment(attachment)}>
              <Icon icon={ExternalLink} size="xs" />
              Open
            </Button>
          ) : null}
          {attachment.filePath && reveal ? (
            <Button variant="ghost" size="xs" onClick={() => reveal.invoke(reveal.target, { path: attachment.filePath! }).catch(reportFailure('Reveal attachment'))}>
              <Icon icon={FolderOpen} size="xs" />
              Reveal
            </Button>
          ) : null}
          <Button variant="ghost" size="icon-xs" aria-label="Hide attachment preview" onClick={onClose}>
            <Icon icon={X} size="xs" />
          </Button>
        </Container>
      </Container>

      {state.status === 'loading' ? (
        <Container layout="horizontal" gap="xs" padding="xs" alignItems="center" minHeight="0">
          <LoadingMark size="sm" />
          <Text variant="body-xs" color="muted">Loading preview</Text>
        </Container>
      ) : null}

      {state.status === 'error' ? (
        <Container layout="vertical" gap="xs" padding="xs" minHeight="0">
          <Text variant="body-xs" color="muted">Preview unavailable.</Text>
          <Text variant="caption" color="faint">{state.message}</Text>
        </Container>
      ) : null}

      {state.status === 'ready' && (state.content || state.bytes) ? (
        state.showFileActions && state.filePath && state.classification?.renderer !== 'image' && editor ? (
          // Real local text file -> the file-editor (CodeMirror): formatted markdown
          // + editable, Cmd+S saves back to the file. Chromeless: the panel above
          // already shows the name + Reveal/Close, so no language badge / copy pile.
          <Container minWidth="0" width="full" overflow="hidden" style={{ height: '22rem' }}>
            <editor.Component target={editor.target} filePath={state.filePath} hideHeader />
          </Container>
        ) : (
          <FileContentRenderer
            filePath={state.filePath}
            content={state.content}
            bytes={state.bytes}
            classification={state.classification}
            maxHeight="16rem"
            showHeader={false}
          />
        )
      ) : null}

      {state.status === 'ready' && !state.content && !state.bytes ? (
        <Container layout="vertical" gap="xs" padding="xs" minHeight="0">
          <Text variant="body-xs" color="muted">
            {attachment.url ? 'Open this link to view the attachment.' : 'This attachment points to a reference that is not loaded in this board view.'}
          </Text>
          <Text variant="caption" color="faint">{attachmentReference(attachment)}</Text>
        </Container>
      ) : null}
    </Container>
  );
}

function AttachmentFieldEditor({ descriptor, value, commit, readOnly, model }: FieldEditorProps) {
  const ownerCapabilities = React.useContext(FieldEditorOwnerCapabilitiesContext);
  const attachments = readAttachmentRefs(value);
  const rawValues = attachmentRawValue(value);
  const [previewId, setPreviewId] = React.useState<string | null>(null);
  const preview = attachments.find((entry) => entry.id === previewId) ?? null;
  // Show the preview the instant a file is attached — no extra click. We
  // record the set of attachment ids; the first time a NEW id appears (after
  // the initial render baseline) we open its preview inline. Manual toggle and
  // close still win because they only run on user intent.
  const seenIdsRef = React.useRef<Set<string> | null>(null);
  const idSignature = attachments.map((entry) => entry.id).join('|');
  React.useEffect(() => {
    const ids = attachments.map((entry) => entry.id);
    if (seenIdsRef.current === null) {
      // First render: establish the baseline without auto-opening existing ones.
      seenIdsRef.current = new Set(ids);
      return;
    }
    const fresh = ids.find((id) => !seenIdsRef.current!.has(id));
    seenIdsRef.current = new Set(ids);
    if (fresh) setPreviewId(fresh);
  }, [idSignature]); // eslint-disable-line react-hooks/exhaustive-deps
  const remove = (index: number) => {
    const next = rawValues.filter((_, candidateIndex) => candidateIndex !== index);
    commit(next.length > 0 ? next : null);
  };
  const add = (typed: string) => {
    const next = attachmentFromText(typed);
    if (!next) return;
    commit([...rawValues, next]);
  };
  if (readOnly && attachments.length === 0) return null;
  return (
    // minWidth=0: this editor is a child of the FieldPills horizontal flex-wrap
    // row, where flex items default to min-width:auto (size to content). The
    // attachment preview is wide, so without this the cell grows to the preview's
    // intrinsic width and overflows the card. minWidth:0 lets it shrink to the
    // row width; the preview (a plain vertical block below) then wraps to fit —
    // exactly how chat/agent-activity render FileContentRenderer in a bounded column.
    <Container layout="vertical" gap="xs" padding="none" minWidth="0" onClick={stop}>
      <Container layout="horizontal" gap="xs" padding="none" alignItems="center" wrap="wrap">
        {attachments.map((attachment, index) => {
          const selected = previewId === attachment.id;
          return (
            <Container key={attachment.id} layout="horizontal" gap="none" padding="none" minHeight="0" alignItems="center">
              <Button
                variant="ghost"
                size="xs"
                aria-label={`${selected ? 'Hide' : 'Open'} ${attachment.label}`}
                aria-expanded={selected}
                onClick={() => setPreviewId((current) => (current === attachment.id ? null : attachment.id))}
              >
                <Badge variant={selected ? 'accent' : 'muted'} interactive>
                  <Icon icon={Paperclip} size="xs" />
                  {attachment.label}
                </Badge>
              </Button>
              <Dropdown
                aria-label={`${attachment.label} actions`}
                items={[
                  { value: 'preview', label: selected ? 'Hide preview' : 'Preview', icon: 'eye' },
                  ...(attachment.url ? [{ value: 'open', label: 'Open link', icon: 'external-link' }] : []),
                  ...(attachment.filePath && ownerCapabilities.attachment?.reveal
                    ? [{ value: 'reveal', label: 'Reveal in Finder', icon: 'folder-open' }]
                    : []),
                  { value: 'copy', label: 'Copy', icon: 'copy' },
                  ...(!readOnly ? [{ value: 'remove', label: 'Remove', icon: 'x' }] : []),
                ]}
                value=""
                align="start"
                customTrigger={(
                  <Button variant="ghost" size="icon-xs" aria-label={`More for ${attachment.label}`} onClick={stop}>
                    <Icon icon={MoreHorizontal} size="xs" />
                  </Button>
                )}
                onValueChange={(picked) => {
                  if (picked === 'preview') setPreviewId((current) => (current === attachment.id ? null : attachment.id));
                  if (picked === 'open') openAttachment(attachment);
                  const reveal = ownerCapabilities.attachment?.reveal;
                  if (picked === 'reveal' && attachment.filePath && reveal) {
                    void reveal.invoke(reveal.target, { path: attachment.filePath }).catch(reportFailure('Reveal attachment'));
                  }
                  if (picked === 'copy') copyAttachment(attachment);
                  if (picked === 'remove') remove(index);
                }}
              />
            </Container>
          );
        })}
        {!readOnly ? (
          <Dropdown
            aria-label={`Add ${descriptor.label.toLowerCase()}`}
            items={[]}
            value=""
            align="start"
            customTrigger={
              attachments.length > 0
                ? (
                  <Badge variant="muted" interactive>
                    <Icon icon={Plus} size="xs" />
                  </Badge>
                )
                : <Text variant="caption" color="faint">—</Text>
            }
            footer={(
              <Container layout="horizontal" padding="none" minHeight="0" onClick={stop}>
                <InlineEditText
                  aria-label={`New ${descriptor.label.toLowerCase()} ref`}
                  value=""
                  variant="body-xs"
                  placeholder="Attach file, log ref, URL…"
                  onCommit={add}
                />
              </Container>
            )}
            renderItem={(item) => dropdownRow(item.label, false)}
          />
        ) : null}
      </Container>
      {preview ? (
        <AttachmentPreviewPanel
          attachment={preview}
          model={model}
          ownerCapabilities={ownerCapabilities}
          onClose={() => setPreviewId(null)}
        />
      ) : null}
    </Container>
  );
}

/** Registry-first dispatch. Exported: composition may register new shapes
 *  (color swatches, rating stars, ...) without touching this dispatcher.
 *  `scale` + `grid` are the generic rating editors, kept in the `rating-editors`
 *  leaf so they compose from `ui` primitives only (no file/CodeMirror graph). */
export const fieldEditorRegistry: Record<string, FieldEditorComponent> = {
  text: TextFieldEditor,
  longtext: TextFieldEditor,
  number: NumberFieldEditor,
  flag: FlagFieldEditor,
  choice: ChoiceFieldEditor,
  multi: MultiFieldEditor,
  temporal: TemporalFieldEditor,
  reference: ReferenceFieldEditor,
  attachments: AttachmentFieldEditor,
  scale: ScaleFieldEditor,
  grid: GridFieldEditor,
};

/** Blind shape→editor dispatch. `extra` is an owner-injected capability map: a
 *  package (or a composition root) adds a NEW shape by passing it here — the
 *  built-in `fieldEditorRegistry` is never edited to gain a shape (enum-dissolution
 *  / L090 / L100). Injected shapes win over built-ins; unknown shapes fall back to
 *  the text editor so the surface never renders nothing. */
export function editorForShape(
  shape: string,
  extra?: Record<string, FieldEditorComponent>,
): FieldEditorComponent {
  return extra?.[shape] ?? fieldEditorRegistry[shape] ?? fieldEditorRegistry.text;
}

// -----------------------------------------------------------------------------
// Generic field controls — the surface places these; this layer dispatches
// -----------------------------------------------------------------------------

/** The surface-wide mutation notifier. EVERY write outcome flows through this
 *  one seam — the mount registers the ui Toast methods here, so success and
 *  failure are always visible to the human (never console-only). Headless
 *  contexts (tests, jscore) keep the console fallback. */
export interface MutationNotifier {
  success: (message: string) => void;
  error: (message: string) => void;
}

let mutationNotifier: MutationNotifier | null = null;
let mutationNotifierGeneration = 0;

// One write = one toast. Batched/parallel writes (drag reorder respread,
// multi-pane mounts) coalesce identical messages inside a short window.
let lastNotice: { message: string; at: number; generation: number } | null = null;

function coalesced(message: string, generation = mutationNotifierGeneration): boolean {
  const now = Date.now();
  if (
    lastNotice
    && lastNotice.generation === generation
    && lastNotice.message === message
    && now - lastNotice.at < 1500
  ) return true;
  lastNotice = { message, at: now, generation };
  return false;
}

export function registerMutationNotifier(notifier: MutationNotifier | null): void {
  mutationNotifierGeneration += 1;
  mutationNotifier = notifier;
  // A notifier registration is a new delivery boundary. Coalescing state
  // from a prior mount/notifier must never suppress the first truthful result
  // delivered to the newly registered surface.
  lastNotice = null;
}

/** Domain editing seam: the mount/surface registers a writer that persists a
 *  descriptor's full value-domain back to the FIELDS data record. Editors add
 *  options through this — custom statuses/priorities are data, not code. */
export type DomainWriter = (
  descriptorId: string,
  values: readonly VisualDatabaseFieldDomainValue[],
) => void;

let domainWriter: DomainWriter | null = null;

export function registerDomainWriter(writer: DomainWriter | null): void {
  domainWriter = writer;
}

/** A save that a newer edit of the same record replaced before it settled: the newer edit is the one kept, so this
 *  attempt ending is the change working, never a failure to tell the person about. */
export class ReplacedByNewerEdit extends Error {
  constructor() { super('A newer edit replaced this save attempt.'); this.name = 'ReplacedByNewerEdit'; }
}

export function reportFailure(scope: string) {
  const notifierAtAttempt = mutationNotifier;
  const generationAtAttempt = mutationNotifierGeneration;
  return (failure: unknown) => {
    if (failure instanceof ReplacedByNewerEdit) return;
    console.error(`[VisualDatabase] ${scope} failed`, failure);
    // A promise belongs to the surface that started it. A later mount may
    // register a different notifier before this attempt settles; never route
    // the old attempt's result into that unrelated surface.
    if (!coalesced(`fail:${scope}`, generationAtAttempt)) notifierAtAttempt?.error(`Couldn't save ${scope}`);
  };
}

/** A refused change uses its caller's words and is not reported as a failed save. */
export function reportRefused(words: string): void {
  if (!coalesced(`refused:${words}`)) mutationNotifier?.error(words);
}

export function reportSuccess(scope: string): void {
  if (!coalesced(scope)) mutationNotifier?.success(scope);
}

/** Captures the notifier that owns an asynchronous attempt. A later mount may
 * register a different delivery boundary before the attempt settles; its
 * success must never leak into that unrelated surface. */
export function reportSuccessFor(scope: string): () => void {
  const notifierAtAttempt = mutationNotifier;
  const generationAtAttempt = mutationNotifierGeneration;
  return () => {
    if (!coalesced(scope, generationAtAttempt)) notifierAtAttempt?.success(scope);
  };
}

/** The lane that means "done" in a view: data decides via tone, never a name
 *  and never position. No tone-success lane = this view has no completion
 *  concept (a positional "last lane is done" guess marked everything in a
 *  single-lane view as completed). */
export function completionLane(lanes: readonly VisualDatabaseLaneDescriptor[]): VisualDatabaseLaneDescriptor | null {
  return lanes.find((lane) => lane.tone === 'success') ?? null;
}

function completionWrites(
  fields: readonly VisualDatabaseFieldDescriptor[] | undefined,
  grouping: VisualDatabaseFieldDescriptor,
  lanes: readonly VisualDatabaseLaneDescriptor[],
  next: boolean,
): readonly FieldWrite[] {
  const done = completionLane(lanes);
  if (!done) return [];
  const revertLane = lanes.find((lane) => lane.id !== done.id && lane.id !== EMPTY_LANE_ID) ?? null;
  const value = next ? done.id : (revertLane?.id ?? null);
  const writes: FieldWrite[] = [{ descriptor: grouping, value }];
  for (const descriptor of fields ?? []) {
    if (descriptor.id === grouping.id) continue;
    if (descriptor.editable === false) continue;
    if (descriptor.role !== 'lane') continue;
    writes.push({ descriptor, value });
  }
  return writes;
}

function referenceDomain(model: VisualDatabaseModel, record: VisualDatabaseRecord): readonly VisualDatabaseFieldDomainValue[] {
  return model.records
    .filter((candidate) => candidate.id !== record.id)
    .map((candidate, index) => ({
      id: recordAddress(candidate) ?? candidate.id,
      label: displayTitle(candidate),
      order: index,
    }));
}

export interface FieldControlContext {
  record: VisualDatabaseRecord;
  model: VisualDatabaseModel;
  view?: VisualDatabaseViewDescriptor;
  lanes: readonly VisualDatabaseLaneDescriptor[];
  grouping: VisualDatabaseFieldDescriptor | null;
  writeRecord?: RecordWriter;
}

/** One field, fully wired: derive shape → resolve domain → registry dispatch
 *  → descriptor-driven durable commit. */
export function FieldControl({ descriptor, record, model, view, lanes, grouping, writeRecord }: FieldControlContext & {
  descriptor: VisualDatabaseFieldDescriptor;
}) {
  const value = extractFieldValue(record, descriptor);
  if (isSurfaceActionRole(descriptor.role)) {
    const actionProps = descriptor.surfaceAction
      ? recordSurfaceIntentToOpenSurfaceProps(value, {
        intentPath: [],
        allowList: descriptor.surfaceAction.allowList,
        label: descriptor.surfaceAction.label ?? descriptor.label,
        detail: descriptor.surfaceAction.detail,
        unavailableMessage: descriptor.surfaceAction.unavailableMessage,
      })
      : null;
    return actionProps ? <OpenSurfaceAction {...actionProps} /> : null;
  }
  const isGrouping = grouping !== null && descriptor.id === grouping.id;
  const shape = isGrouping
    ? (Array.isArray(value) ? 'multi' : 'choice')
    : deriveShape(value, descriptor);
  const domain = isGrouping
    ? lanes.filter((lane) => lane.id !== EMPTY_LANE_ID)
    : shape === 'reference'
      ? referenceDomain(model, record)
      : shape === 'choice' || shape === 'multi'
        ? effectiveDomain(descriptor, model, view)
        : [];
  const Editor = editorForShape(shape);
  // Actions attached to THIS field in the actions data record (action.fieldId)
  // surface on each chosen value's chip menu — the agnostic assignee door.
  const fieldActions = model.actions.filter((action) => action.fieldId === descriptor.id);
  return (
    <Editor
      record={record}
      descriptor={descriptor}
      value={value}
      domain={domain}
      readOnly={!writeRecord || !canEditRecord(record)}
      fieldActions={fieldActions}
      model={model}
      commit={(next) => {
        if (!writeRecord) return;
        writeField(writeRecord, record, [{ descriptor, value: next }]).catch(reportFailure(descriptor.label));
      }}
    />
  );
}

/** Structural bindings rendered by dedicated zones (title/body) or dedicated
 *  interactions (sort = drag re-order, id = identity). Everything else gets a
 *  pill editor, in descriptor order — including discovered fields. */
// Roles that never render as property pills: zoned content (title/body),
// machine identity (id/sort), and structural classification (kind/group/link) —
// the row already lives inside its view/section, restating "record record"
// as pills is noise, not information.
// 'nesting' is the field a record's place under another is kept in: the view draws it as the nesting itself.
const ZONED_ROLES: readonly string[] = ['id', 'title', 'body', 'sort', 'kind', 'group', 'link', 'nesting'];
const SURFACE_ACTION_ROLES: readonly string[] = ['surface-action', 'surface-actions'];

function isSurfaceActionRole(role: string): boolean {
  return SURFACE_ACTION_ROLES.includes(role);
}

function pillEligible(descriptor: VisualDatabaseFieldDescriptor): boolean {
  // Read-only is a mutation policy, not a visibility policy. Evidence/status
  // fields in owner projections must still render; their shape editor already
  // receives readOnly=true and exposes no mutation path.
  return !ZONED_ROLES.includes(descriptor.role);
}

function addFieldMenuEligible(descriptor: VisualDatabaseFieldDescriptor): boolean {
  return !isSurfaceActionRole(descriptor.role)
    && descriptor.editable !== false
    && pillEligible(descriptor)
    && descriptor.source !== 'discovered';
}

function autoShowPill(descriptor: VisualDatabaseFieldDescriptor): boolean {
  return descriptor.source !== 'discovered';
}

function fieldValuePresent(descriptor: VisualDatabaseFieldDescriptor, value: unknown): boolean {
  if (Array.isArray(value)) {
    if (descriptor.role === 'badge' && descriptor.shape === 'multi') {
      return value.map(String).some((entry) => !isEmptyPeopleValue(entry));
    }
    return value.length > 0;
  }
  return value !== null && value !== undefined;
}

function visibleTemporalPillKey(record: VisualDatabaseRecord, descriptor: VisualDatabaseFieldDescriptor): string | null {
  const value = extractFieldValue(record, descriptor);
  if (Array.isArray(value) || typeof value !== 'string') return null;
  if (deriveShape(value, descriptor) !== 'temporal') return null;
  const label = shortDate(value);
  return label ? `temporal:${label}` : null;
}

function collapseDuplicateTemporalFaces(
  record: VisualDatabaseRecord,
  descriptors: readonly VisualDatabaseFieldDescriptor[],
  added: readonly string[],
): readonly VisualDatabaseFieldDescriptor[] {
  const seen = new Set<string>();
  return descriptors.filter((descriptor) => {
    if (added.includes(descriptor.id)) return true;
    const key = visibleTemporalPillKey(record, descriptor);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The pill row shows ONLY fields carrying a value on THIS record (the Amie
 *  density rule: nothing renders unless the user needs it now). The full
 *  descriptor universe — including every discovered field — lives behind one
 *  add-field affordance, searchable, so breadth never floods the card. */
export function FieldPills(props: FieldControlContext) {
  const [added, setAdded] = React.useState<readonly string[]>([]);
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const eligible = props.model.fields.filter(pillEligible);
  const addMenuEligible = props.model.fields.filter(addFieldMenuEligible);
  const detailFields = eligible.filter((descriptor) => {
    if (descriptor.source !== 'discovered') return false;
    return fieldValuePresent(descriptor, extractFieldValue(props.record, descriptor));
  });
  const present = eligible.filter((descriptor) => {
    if (added.includes(descriptor.id)) return true;
    if (!autoShowPill(descriptor)) return false;
    const value = extractFieldValue(props.record, descriptor);
    return fieldValuePresent(descriptor, value);
  });
  const visible = collapseDuplicateTemporalFaces(props.record, present, added);
  const presentIds = new Set(visible.map((descriptor) => descriptor.id));
  const addable = addMenuEligible.filter((descriptor) => !presentIds.has(descriptor.id));
  return (
    <>
      {visible.map((descriptor) => (
        <FieldControl key={descriptor.id} descriptor={descriptor} {...props} />
      ))}
      {props.writeRecord && canEditRecord(props.record) && addable.length > 0 ? (
        <Dropdown
          aria-label="Add field"
          items={addable.map((descriptor) => ({ value: descriptor.id, label: fieldMenuLabel(descriptor) }))}
          value=""
          align="start"
          scrollable
          customTrigger={(
            <Button variant="ghost" size="xs" aria-label="Add field" onClick={stop}>
              <Icon icon={Plus} size="xs" />
            </Button>
          )}
          renderItem={(item) => dropdownRow(item.label, false)}
          onValueChange={(id) => {
            if (id) setAdded((current) => (current.includes(id) ? current : [...current, id]));
          }}
        />
      ) : null}
      {detailFields.length > 0 ? (
        <>
          <Button
            variant="ghost"
            size="xs"
            aria-label="All details"
            onClick={(event: React.MouseEvent) => {
              event.stopPropagation();
              setDetailsOpen(true);
            }}
          >
            <Icon icon={Info} size="xs" />
          </Button>
          <FloatingPanel open={detailsOpen} onClose={() => setDetailsOpen(false)} title="All details" width={672}>
            <Container layout="vertical" gap="sm" padding="none" className="max-h-[60vh] overflow-auto pr-1">
              {detailFields.map((descriptor) => (
                <Container
                  key={descriptor.id}
                  layout="horizontal"
                  justifyContent="between"
                  alignItems="center"
                  gap="md"
                  padding="sm"
                  className="rounded-md bg-white/[0.04]"
                  onClick={stop}
                >
                  <Text variant="body-xs" color="muted">{fieldMenuLabel(descriptor)}</Text>
                  <Container layout="horizontal" justifyContent="end" alignItems="center" gap="xs" padding="none" minWidth="0">
                    <FieldControl descriptor={descriptor} {...props} />
                  </Container>
                </Container>
              ))}
            </Container>
          </FloatingPanel>
        </>
      ) : null}
    </>
  );
}

/** The title zone uses the seamless InlineEditText primitive (the Amie /
 *  record-audio pattern): the text IS the input — no border, no box,
 *  clicking places the caret. The body zone is the record's notes as a
 *  document (NotesDocument). Read-only records render plain Text. */
export function ZoneEditor({
  record,
  model,
  role,
  writeRecord,
  expanded = false,
}: {
  record: VisualDatabaseRecord;
  model: VisualDatabaseModel;
  role: 'title' | 'body';
  writeRecord?: RecordWriter;
  /** Body zone only: render the multiline editor even when empty. */
  expanded?: boolean;
}) {
  const found = model.fields.find((descriptor) => descriptor.role === role);
  const descriptor = found ?? { ...syntheticFieldDescriptor(role), role };
  const value = extractFieldValue(record, descriptor);
  const text = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  const isTitle = role === 'title';
  const display = isTitle ? (text || record.title) : text;
  const readOnly = !writeRecord || !canEditRecord(record);

  if (readOnly) {
    if (!display) return null;
    return (
      <Text variant={isTitle ? 'body-xs' : 'caption'} color={isTitle ? 'strong' : 'muted'} truncate={isTitle}>
        {isTitle ? displayTitle(record) : display}
      </Text>
    );
  }
  if (!isTitle && !display && !expanded) return null;
  if (!isTitle) {
    return (
      <NotesDocument
        text={display}
        label={descriptor.label}
        onKeep={async (next) => {
          if (!writeRecord) return;
          try {
            await writeField(writeRecord, record, [{ descriptor, value: next.length > 0 ? next : null }]);
          } catch (error) {
            reportFailure(descriptor.label)(error);
            throw error;
          }
        }}
      />
    );
  }
  return (
    <Container layout="vertical" padding="none" flex="1" minHeight="0" onClick={stop}>
      <InlineEditText
        aria-label={descriptor.label}
        value={isMachineString(display) ? displayTitle(record) : display}
        // Amie rows: regular-weight 13px title, not bold heading chrome.
        variant="body"
        tone="primary"
        placeholder="Untitled"
        onCommit={(next) => {
          if (!writeRecord) return;
          writeField(writeRecord, record, [{ descriptor, value: next.length > 0 ? next : null }])
            .catch(reportFailure(descriptor.label));
        }}
      />
    </Container>
  );
}

/** Amie-style completion ring wired to the grouping write: marking complete
 *  moves the record into the completion lane; unmarking returns it to the
 *  first non-complete lane. Optimistic — the ring flips on click and reverts
 *  only on write failure. */
export function CompleteControl({
  record,
  lanes,
  grouping,
  fields,
  writeRecord,
}: {
  record: VisualDatabaseRecord;
  lanes: readonly VisualDatabaseLaneDescriptor[];
  grouping: VisualDatabaseFieldDescriptor | null;
  fields?: readonly VisualDatabaseFieldDescriptor[];
  writeRecord?: RecordWriter;
}) {
  const [busy, setBusy] = React.useState(false);
  const [optimistic, setOptimistic] = React.useState<boolean | null>(null);
  const done = completionLane(lanes);
  const storedDone = done !== null && grouping !== null
    && recordGroupValues(record, grouping).includes(done.id);
  React.useEffect(() => { setOptimistic(null); }, [storedDone]);
  if (!writeRecord || !canEditRecord(record) || !done || !grouping) return null;
  const isDone = optimistic ?? storedDone;
  return (
    <CompletionRing
      done={isDone}
      disabled={busy}
      data-reach-action="complete-action"
      onToggle={(next) => {
        setOptimistic(next);
        setBusy(true);
        writeField(writeRecord, record, completionWrites(fields, grouping, lanes, next))
          .catch((failure) => { setOptimistic(null); reportFailure('complete')(failure); })
          .finally(() => setBusy(false));
      }}
    />
  );
}

export function OverflowMenu({
  record,
  lanes,
  grouping,
  writeRecord,
  model,
  onDeleteStart,
  onDeleteFailure,
  onOpen,
}: {
  record: VisualDatabaseRecord;
  lanes: readonly VisualDatabaseLaneDescriptor[];
  grouping: VisualDatabaseFieldDescriptor | null;
  writeRecord?: RecordWriter;
  model?: VisualDatabaseModel;
  onDeleteStart?: (record: VisualDatabaseRecord) => void;
  onDeleteFailure?: (record: VisualDatabaseRecord) => void;
  /** Opens the record where the list that holds it shows a record whole (its own page or panel). */
  onOpen?: (record: VisualDatabaseRecord) => void;
}) {
  const done = completionLane(lanes);
  const editable = Boolean(writeRecord && canEditRecord(record));
  const currentLanes = grouping ? recordGroupValues(record, grouping) : [];
  const canComplete = Boolean(editable && done && grouping && !currentLanes.includes(done.id));
  // "Set <field> →" submenus (Amie ref 47): every declared-domain field that
  // is NOT the grouping gets one nested entry — values come from data, child
  // selection writes through the same writeField seam. Fully descriptor-
  // driven: a new domain field in the data record = a new submenu, zero code.
  const setterFields = editable && model
    ? model.fields.filter((descriptor) => (
      descriptor.editable !== false
      && descriptor.domain !== undefined
      && descriptor.id !== grouping?.id
      && !['id', 'title', 'body', 'sort', 'kind', 'group', 'link'].includes(descriptor.role)
    ))
    : [];
  // Amie overflow anatomy (ref 72): iconed rows throughout — Mark as done
  // (kbd D), Move to → submenu with tone-tinted rows, Set-<field> → data-
  // driven submenus, Copy title ⌘C, then trash-iconed red Delete last. All
  // icon/tint/shortcut handling is the Dropdown's generic per-item data
  // (the agent-management pattern) — zero custom row markup here.
  const items = [
    ...(onOpen ? [{ value: 'open', label: 'Open', icon: 'arrow-up-right' }] : []),
    ...(canComplete ? [{ value: 'complete', label: 'Mark as done', icon: 'check', shortcut: 'D' }] : []),
    ...(editable && grouping ? [{
      value: 'move',
      label: 'Move to',
      icon: 'circle-dot',
      children: lanes
        .filter((lane) => lane.id !== EMPTY_LANE_ID && !currentLanes.includes(lane.id))
        .map((lane) => ({ value: `move:${lane.id}`, label: humanize(lane.label), tint: domainValueColor(lane) })),
    }] : []),
    ...setterFields.map((descriptor) => ({
      value: `set:${descriptor.id}`,
      label: `Set ${descriptor.label.toLowerCase()}`,
      icon: 'diamond',
      children: [
        ...(descriptor.domain?.values ?? []).map((entry) => ({
          value: `setvalue:${descriptor.id}:${entry.id}`,
          label: humanize(entry.label),
          tint: domainValueColor(entry),
        })),
        { value: `setvalue:${descriptor.id}:`, label: `No ${descriptor.label.toLowerCase()}` },
      ],
    })),
    { value: 'copy-title', label: 'Copy title', icon: 'copy', shortcut: '⌘C' },
    ...(editable ? [{ value: 'delete', label: 'Delete', icon: 'trash-2', tint: 'var(--status-error, #ef4444)' }] : []),
  ];
  return (
    <Dropdown
      aria-label="More actions"
      items={items}
      value=""
      align="end"
      data-reach-action="edit-record"
      customTrigger={(
        <Button variant="ghost" size="xs" aria-label="More actions" onClick={stop}>
          <Icon icon={MoreHorizontal} size="xs" />
        </Button>
      )}
      onValueChange={(action) => {
        if (action === 'open') { onOpen?.(record); return; }
        if (!writeRecord) {
          if (action === 'copy-title') void navigator.clipboard?.writeText(record.title).catch(() => {});
          return;
        }
        if (action.startsWith('setvalue:')) {
          const [, descriptorId, optionId] = action.split(':');
          const descriptor = model?.fields.find((candidate) => candidate.id === descriptorId);
          if (descriptor) {
            writeField(writeRecord, record, [{ descriptor, value: optionId ? optionId : null }])
              .catch(reportFailure(descriptor.label));
          }
        } else if (action === 'complete' && done && grouping) {
          writeField(writeRecord, record, completionWrites(model?.fields, grouping, lanes, true)).catch(reportFailure('complete'));
        } else if (action.startsWith('move:') && grouping) {
          writeField(writeRecord, record, [{ descriptor: grouping, value: action.slice(5) }]).catch(reportFailure('move'));
        } else if (action === 'copy-title') {
          void navigator.clipboard?.writeText(record.title).catch(() => {});
        } else if (action === 'delete') {
          // Delete = null payload at the record's address: the log keeps
          // history; the projection drops the row. Honest data deletion.
          const deletion = buildRecordDeletion(record);
          if (deletion) {
            onDeleteStart?.(record);
            writeRecord(deletion)
              .then(() => reportSuccess('Deleted'))
              .catch((failure) => {
                onDeleteFailure?.(record);
                reportFailure('delete')(failure);
              });
          }
        }
      }}
    />
  );
}
