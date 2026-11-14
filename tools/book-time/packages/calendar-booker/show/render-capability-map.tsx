// packages/calendar-booker/show/render-capability-map.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Leaf capability pack: the ONE place `render_kind` strings bind to concrete
// `ui` primitives, and the ONE place the owner tone vocabulary (`attention` |
// `positive` | `danger` | …) maps to the ui status tone. It lives OUTSIDE the
// blind renderer (`descriptor-surface.tsx`) so the renderer can stay a generic
// O(1) `caps.get(node.render_kind)` dispatcher (L090 / enum dissolution: the
// dispatcher never enumerates what it handles — this data does).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Adding a new `render_kind` = adding ONE row to `RENDER_CAPABILITIES`. No
//    edit to the renderer, no new switch arm anywhere.
// 2. Adding a new owner tone = adding ONE row to `TONE_BINDINGS`. Unknown tones
//    fall back to `neutral` — never a thrown error, never a hardcoded color.
// 3. Human content (`label`, `status.label`, `status.reason`, `option.label`)
//    is printed VERBATIM. The `status` binding routes the feed label+tone through
//    `statusView` via an override so the ui BASE_VOCABULARY humanizer can never
//    rewrite owner-translated booking text.
// 4. Tone-bearing status uses `StatusDot` + `Text` (semantic tone), NOT
//    `StatusRow`/`StatusCard` (those are passRate quality tints, not tone).
//
// =============================================================================

import * as React from 'react';
import {
  ActionControl,
  Card,
  Container,
  DatePicker,
  Input,
  OutputFieldList,
  SelectablePillBar,
  StatusDot,
  StructuredValueEditor,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Text,
  statusView,
  type OutputField,
  type StatusTone,
} from '@/packages/ui';
import { DescriptorSurface } from '@/packages/calendar-booker/show/descriptor-surface';
import type { ActionDescriptor, ViewDescriptor } from '@/packages/calendar-booker/show/view-descriptor';

// ---------------------------------------------------------------------------
// CAPABILITY CONTRACT
// ---------------------------------------------------------------------------

/** Props every bound render component receives. Identical to the renderer's. */
export interface RenderProps {
  node: ViewDescriptor;
  caps: RenderCapabilityMap;
  onAction?: (action: ActionDescriptor, node: ViewDescriptor) => void;
  onValueChange?: (node: ViewDescriptor, value: unknown) => void;
}

export type RenderComponent = (props: RenderProps) => React.ReactElement | null;

/** Opaque `render_kind` → primitive binding. Read-only by contract. */
export type RenderCapabilityMap = ReadonlyMap<string, RenderComponent>;

// ---------------------------------------------------------------------------
// OWNER TONE VOCABULARY → ui TONE (leaf binding, neutral fallback)
// ---------------------------------------------------------------------------

const TONE_BINDINGS: ReadonlyMap<string, StatusTone> = new Map<string, StatusTone>([
  ['attention', 'warning'],
  ['positive', 'success'],
  ['danger', 'error'],
  ['info', 'info'],
  ['neutral', 'neutral'],
]);

function toneToStatusTone(toneRef: string): StatusTone {
  return TONE_BINDINGS.get(toneRef) ?? 'neutral';
}

const DOT_BINDINGS: ReadonlyMap<StatusTone, 'success' | 'warning' | 'error' | 'info' | 'idle'> = new Map([
  ['success', 'success'],
  ['warning', 'warning'],
  ['error', 'error'],
  ['info', 'info'],
  ['neutral', 'idle'],
]);

function statusToneToDot(tone: StatusTone): 'success' | 'warning' | 'error' | 'info' | 'idle' {
  return DOT_BINDINGS.get(tone) ?? 'idle';
}

// ---------------------------------------------------------------------------
// SHARED HELPERS
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function isEditable(node: ViewDescriptor): boolean {
  return node.editable !== false;
}

function renderChildren(props: RenderProps): React.ReactNode {
  const children = props.node.children ?? [];
  return children.map((child) => (
    <DescriptorSurface
      key={child.id}
      node={child}
      caps={props.caps}
      onAction={props.onAction}
      onValueChange={props.onValueChange}
    />
  ));
}

/** Owner-translated status: tone via vocabulary, label printed verbatim. */
function StatusLine({ node }: { node: ViewDescriptor }): React.ReactElement | null {
  const status = node.status;
  if (!status) return null;
  const tone = toneToStatusTone(status.tone_ref);
  const view = statusView(node.id, { [node.id]: { label: status.label, tone } });
  return (
    <Container layout="vertical" gap="2xs">
      <Container layout="horizontal" gap="sm" alignItems="center">
        <StatusDot status={statusToneToDot(view.tone)} label={view.label} />
        <Text variant="body" color="strong">
          {view.label}
        </Text>
      </Container>
      {status.reason ? (
        <Text variant="caption" color="muted">
          {status.reason}
        </Text>
      ) : null}
    </Container>
  );
}

// ---------------------------------------------------------------------------
// FIELD BINDINGS
// ---------------------------------------------------------------------------

function makeFieldInput(type: 'text' | 'number'): RenderComponent {
  return function FieldInput(props: RenderProps): React.ReactElement {
    const { node, onValueChange } = props;
    if (!isEditable(node)) {
      return (
        <Container layout="vertical" gap="2xs">
          {node.label ? (
            <Text variant="label" color="muted">
              {node.label}
            </Text>
          ) : null}
          <Text variant="body" color="strong">
            {toText(node.value)}
          </Text>
        </Container>
      );
    }
    return (
      <Input
        label={node.label}
        hint={node.help}
        type={type}
        value={toText(node.value)}
        onChange={(event) => onValueChange?.(node, event.target.value)}
      />
    );
  };
}

function FieldDateTime(props: RenderProps): React.ReactElement {
  const { node, onValueChange } = props;
  const value = typeof node.value === 'string' ? node.value : null;
  if (!isEditable(node)) {
    return (
      <Container layout="vertical" gap="2xs">
        {node.label ? (
          <Text variant="label" color="muted">
            {node.label}
          </Text>
        ) : null}
        <Text variant="body" color="strong">
          {toText(node.value)}
        </Text>
      </Container>
    );
  }
  return (
    <Container layout="vertical" gap="2xs">
      {node.label ? (
        <Text variant="label" color="muted">
          {node.label}
        </Text>
      ) : null}
      <DatePicker
        value={value}
        aria-label={node.label}
        onChange={(next) => onValueChange?.(node, next)}
      />
    </Container>
  );
}

function FieldStructured(props: RenderProps): React.ReactElement {
  const { node, onValueChange } = props;
  return (
    <Container layout="vertical" gap="2xs">
      {node.label ? (
        <Text variant="label" color="muted">
          {node.label}
        </Text>
      ) : null}
      <StructuredValueEditor
        value={node.value}
        readOnly={!isEditable(node)}
        onChange={(next) => onValueChange?.(node, next)}
      />
    </Container>
  );
}

function FieldList(props: RenderProps): React.ReactElement {
  const fields: OutputField[] = Array.isArray(props.node.value)
    ? props.node.value.filter(isRecord).map((row) => ({
        key: toText(row.key ?? row.id),
        label: typeof row.label === 'string' ? row.label : undefined,
        value: row.value,
      }))
    : [];
  return (
    <Container layout="vertical" gap="2xs">
      {props.node.label ? (
        <Text variant="label" color="muted">
          {props.node.label}
        </Text>
      ) : null}
      <OutputFieldList fields={fields} />
    </Container>
  );
}

// ---------------------------------------------------------------------------
// CHOICE BINDING
// ---------------------------------------------------------------------------

function ChipsSingleSelect(props: RenderProps): React.ReactElement {
  const { node, onValueChange } = props;
  const items = (node.options ?? []).map((option) => ({ id: option.value, label: option.label }));
  const selected = toText(node.value);
  return (
    <Container layout="vertical" gap="2xs">
      {node.label ? (
        <Text variant="label" color="muted">
          {node.label}
        </Text>
      ) : null}
      <SelectablePillBar
        items={items}
        selectedIds={selected ? [selected] : []}
        ariaLabel={node.label}
        onToggle={(id) => onValueChange?.(node, id)}
        onSelectAll={() => undefined}
      />
    </Container>
  );
}

// ---------------------------------------------------------------------------
// STATUS BINDINGS
// ---------------------------------------------------------------------------

function StatusRowBinding(props: RenderProps): React.ReactElement {
  return (
    <Container layout="vertical" gap="2xs">
      {props.node.label ? (
        <Text variant="label" color="muted">
          {props.node.label}
        </Text>
      ) : null}
      <StatusLine node={props.node} />
    </Container>
  );
}

function StatusCardBinding(props: RenderProps): React.ReactElement {
  return (
    <Card>
      <Container layout="vertical" gap="sm" padding="md">
        {props.node.label ? (
          <Text variant="heading-xs" color="strong">
            {props.node.label}
          </Text>
        ) : null}
        <StatusLine node={props.node} />
        {renderChildren(props)}
      </Container>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ACTION BINDING
// ---------------------------------------------------------------------------

function ActionBar(props: RenderProps): React.ReactElement {
  const actions = props.node.actions ?? [];
  return (
    <Container layout="horizontal" gap="sm" wrap="wrap" alignItems="center">
      {actions.map((action) => (
        <ActionControl
          key={action.action_ref}
          disabled={!!action.disabled_reason}
          title={action.disabled_reason}
          onClick={() => props.onAction?.(action, props.node)}
        >
          {action.label}
        </ActionControl>
      ))}
    </Container>
  );
}

// ---------------------------------------------------------------------------
// STRUCTURAL BINDINGS
// ---------------------------------------------------------------------------

function GroupBinding(props: RenderProps): React.ReactElement {
  return (
    <Container layout="vertical" gap="md">
      {props.node.label ? (
        <Text variant="heading-xs" color="strong">
          {props.node.label}
        </Text>
      ) : null}
      {props.node.help ? (
        <Text variant="caption" color="muted">
          {props.node.help}
        </Text>
      ) : null}
      {renderChildren(props)}
    </Container>
  );
}

function PreviewEmbed(props: RenderProps): React.ReactElement {
  return (
    <Card>
      <Container layout="vertical" gap="md" padding="md">
        {props.node.label ? (
          <Text variant="label" color="muted">
            {props.node.label}
          </Text>
        ) : null}
        {renderChildren(props)}
      </Container>
    </Card>
  );
}

function TableBinding(props: RenderProps): React.ReactElement {
  const value = isRecord(props.node.value) ? props.node.value : {};
  const columns = Array.isArray(value.columns) ? value.columns.filter(isRecord) : [];
  const rows = Array.isArray(value.rows) ? value.rows.filter(isRecord) : [];
  const columnKeys = columns.map((column) => toText(column.key ?? column.id));
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((column, index) => (
            <TableHead key={columnKeys[index] || index}>{toText(column.label)}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, rowIndex) => (
          <TableRow key={toText(row.id) || rowIndex}>
            {columnKeys.map((columnKey, cellIndex) => (
              <TableCell key={columnKey || cellIndex}>{toText(row[columnKey])}</TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// THE BINDING TABLE — the only place `render_kind` strings appear, and it is DATA
// ---------------------------------------------------------------------------

export const RENDER_CAPABILITIES: RenderCapabilityMap = new Map<string, RenderComponent>([
  ['group', GroupBinding],
  ['field.text', makeFieldInput('text')],
  ['field.number', makeFieldInput('number')],
  ['field.datetime', FieldDateTime],
  ['field.structured', FieldStructured],
  ['field.list', FieldList],
  ['chips.single-select', ChipsSingleSelect],
  ['status.row', StatusRowBinding],
  ['status.card', StatusCardBinding],
  ['action.bar', ActionBar],
  ['preview.embed', PreviewEmbed],
  ['table', TableBinding],
]);

export const calendarBookerRenderCapabilities = RENDER_CAPABILITIES;

export default RENDER_CAPABILITIES;
