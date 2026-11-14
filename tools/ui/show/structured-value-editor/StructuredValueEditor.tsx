// packages/ui/show/structured-value-editor/StructuredValueEditor.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Generic structured editor/viewer for an unknown JSON-shaped value. Objects
// render as labeled field rows, arrays as numbered item rows, scalars as a
// single input — recursively, to any depth. The thing every serious workflow
// tool (n8n parameter panel, Zapier field list, Retool inspector) gets right:
// users edit FIELDS, never raw JSON text. Raw text editing exists only behind
// an explicit "Edit as text" disclosure for shapes fields can't express.
//
// Pure Physics: value in, onChange(value) out. Zero domain vocabulary —
// works for workflow steps, query configs, record payloads, anything.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ZERO application vocabulary. Field names come from the data itself.
// 2. Type-preserving edits: a number field stays a number, a boolean stays a
//    boolean, null stays null until the user types something.
// 3. readOnly mode renders the same anatomy without inputs' mutability.
// 4. The raw-text fallback is a disclosure, never the default surface.
// 5. ui primitives + tokens only; inline style limited to geometry.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useEffect, useState } from 'react';
import {
  ChevronDown as ChevronDownIcon,
  ChevronRight as ChevronRightIcon,
  Plus as PlusIcon,
  Trash2 as TrashIcon,
} from 'lucide-react';
import { Button } from '../button';
import { Container } from '../container';
import { Icon } from '../icon';
import { Input, Textarea } from '../input';
import { Text } from '../text';
import { Toggle } from '../toggle';

export interface StructuredValueEditorProps {
  /** The value being edited (any JSON-shaped data). */
  value: unknown;
  /** Emitted with the FULL new value on every field edit. */
  onChange?: (value: unknown) => void;
  /** Render the same anatomy without mutation affordances. */
  readOnly?: boolean;
  /** Nesting depth (internal — leave unset at call sites). */
  depth?: number;
  /** Max depth rendered as fields before falling back to text (default 4). */
  maxDepth?: number;
  /**
   * Caller-supplied translation hook (L090: the editor never enumerates what
   * it renders — domains inject their own meaning). Called for every nested
   * value; returning non-null replaces that subtree's default field anatomy
   * with the custom rendering. Return null to keep the default.
   */
  renderValue?: (value: unknown, label: string | null) => React.ReactNode | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** "item_var" / "definition_id" → "Item Var" / "Definition Id". */
function humanizeKey(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** Parse a text edit back into the field's original type when possible. */
function parseScalar(text: string, previous: unknown): unknown {
  if (typeof previous === 'number') {
    const parsed = Number(text);
    return text.trim() !== '' && Number.isFinite(parsed) ? parsed : text;
  }
  if (previous === null && text.trim() === '') return null;
  return text;
}

function scalarText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return String(value);
}

/** One scalar field row: label + typed input (or static text in readOnly). */
function ScalarField({
  label,
  value,
  readOnly,
  onChange,
}: {
  label: string | null;
  value: unknown;
  readOnly: boolean;
  onChange: (value: unknown) => void;
}): React.ReactElement {
  if (typeof value === 'boolean') {
    return (
      <Container layout="horizontal" gap="sm" alignItems="center">
        {label && (
          <Container flex={1} style={{ minWidth: 0 }}>
            <Text variant="caption" color="muted" truncate title={label}>{label}</Text>
          </Container>
        )}
        <Toggle
          checked={value}
          disabled={readOnly}
          onCheckedChange={(checked) => onChange(checked)}
          label={value ? 'Yes' : 'No'}
        />
      </Container>
    );
  }
  if (readOnly) {
    return (
      <Container layout="horizontal" gap="sm" alignItems="center">
        {label && (
          <Container style={{ minWidth: '96px', maxWidth: '40%' }}>
            <Text variant="caption" color="muted" truncate title={label}>{label}</Text>
          </Container>
        )}
        <Container flex={1} style={{ minWidth: 0 }}>
          <Text variant="caption" truncate title={scalarText(value)}>
            {scalarText(value) || '—'}
          </Text>
        </Container>
      </Container>
    );
  }
  return (
    <Input
      label={label ?? undefined}
      value={scalarText(value)}
      onChange={(event) => onChange(parseScalar(event.target.value, value))}
    />
  );
}

/** Collapsible nested group (object inside object, etc.). */
function NestedGroup({
  label,
  children,
  defaultOpen = true,
}: {
  label: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Container layout="vertical" gap="xs">
      <Button variant="ghost" size="sm" onClick={() => setOpen((current) => !current)}>
        <Container layout="horizontal" gap="xs" alignItems="center" width="full">
          <Icon icon={open ? ChevronDownIcon : ChevronRightIcon} size="xs" />
          <Container flex={1} style={{ minWidth: 0, textAlign: 'left' }}>
            <Text variant="caption" weight="semibold" truncate>{label}</Text>
          </Container>
        </Container>
      </Button>
      {open && (
        <Container
          layout="vertical"
          gap="sm"
          style={{
            paddingLeft: '12px',
            borderLeftWidth: '1px',
            borderLeftStyle: 'solid',
            borderLeftColor: 'var(--border-primary)',
          }}
        >
          {children}
        </Container>
      )}
    </Container>
  );
}

/** Raw text fallback, behind a disclosure — never the default surface. */
function TextFallback({
  value,
  readOnly,
  onChange,
}: {
  value: unknown;
  readOnly: boolean;
  onChange: (value: unknown) => void;
}): React.ReactElement {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2) ?? 'null');
  const [error, setError] = useState('');
  useEffect(() => {
    setText(JSON.stringify(value, null, 2) ?? 'null');
    setError('');
  }, [value]);
  return (
    <Container layout="vertical" gap="xs">
      <Textarea
        rows={5}
        readOnly={readOnly}
        value={text}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          try {
            onChange(JSON.parse(next) as unknown);
            setError('');
          } catch {
            setError('Finish the edit so it reads as valid JSON.');
          }
        }}
      />
      {error && <Text variant="caption" color="warning">{error}</Text>}
    </Container>
  );
}

/**
 * The recursive structured editor. Objects → field rows; arrays → item rows
 * with add/remove; scalars → typed inputs. Depth-capped to keep pathological
 * payloads readable — beyond the cap, the text fallback takes over.
 */
export const StructuredValueEditor: React.FC<StructuredValueEditorProps> = ({
  value,
  onChange,
  readOnly = false,
  depth = 0,
  maxDepth = 4,
  renderValue,
}) => {
  const emit = onChange ?? (() => {});
  const [showRaw, setShowRaw] = useState(false);

  // Domain translation hook: the caller may replace any subtree with its own
  // human rendering (e.g. a workflow binding as one plain sentence).
  const custom = renderValue?.(value, null);
  if (custom != null) return <>{custom}</>;

  if (depth >= maxDepth) {
    return <TextFallback value={value} readOnly={readOnly} onChange={emit} />;
  }

  if (isRecord(value)) {
    const entries = Object.entries(value);
    return (
      <Container layout="vertical" gap="sm" data-structured-value-editor="true">
        {entries.length === 0 && (
          <Text variant="caption" color="muted">No fields yet</Text>
        )}
        {entries.map(([key, child]) => {
          const setChild = (next: unknown) => emit({ ...value, [key]: next });
          const childCustom = renderValue?.(child, humanizeKey(key));
          if (childCustom != null) {
            return <React.Fragment key={key}>{childCustom}</React.Fragment>;
          }
          if (isRecord(child) || Array.isArray(child)) {
            return (
              <NestedGroup key={key} label={humanizeKey(key)}>
                <StructuredValueEditor
                  value={child}
                  onChange={setChild}
                  readOnly={readOnly}
                  depth={depth + 1}
                  maxDepth={maxDepth}
                  renderValue={renderValue}
                />
              </NestedGroup>
            );
          }
          return (
            <ScalarField
              key={key}
              label={humanizeKey(key)}
              value={child}
              readOnly={readOnly}
              onChange={setChild}
            />
          );
        })}
        {!readOnly && depth === 0 && (
          <Container layout="horizontal" gap="xs" justifyContent="end">
            <Button variant="ghost" size="sm" onClick={() => setShowRaw((current) => !current)}>
              {showRaw ? 'Hide text view' : 'Edit as text'}
            </Button>
          </Container>
        )}
        {showRaw && <TextFallback value={value} readOnly={readOnly} onChange={emit} />}
      </Container>
    );
  }

  if (Array.isArray(value)) {
    return (
      <Container layout="vertical" gap="sm" data-structured-value-editor="true">
        {value.length === 0 && (
          <Text variant="caption" color="muted">Empty list</Text>
        )}
        {value.map((item, index) => {
          const setItem = (next: unknown) =>
            emit(value.map((candidate, candidateIndex) =>
              (candidateIndex === index ? next : candidate)));
          const removeItem = () =>
            emit(value.filter((_, candidateIndex) => candidateIndex !== index));
          return (
            <Container key={index} layout="horizontal" gap="xs" alignItems="start">
              <Container flex={1} style={{ minWidth: 0 }}>
                {isRecord(item) || Array.isArray(item) ? (
                  <NestedGroup label={`Item ${index + 1}`}>
                    <StructuredValueEditor
                      value={item}
                      onChange={setItem}
                      readOnly={readOnly}
                      depth={depth + 1}
                      maxDepth={maxDepth}
                    />
                  </NestedGroup>
                ) : (
                  <ScalarField
                    label={null}
                    value={item}
                    readOnly={readOnly}
                    onChange={setItem}
                  />
                )}
              </Container>
              {!readOnly && (
                <Button variant="ghost" size="sm" aria-label="Remove item" onClick={removeItem}>
                  <Icon icon={TrashIcon} size="xs" />
                </Button>
              )}
            </Container>
          );
        })}
        {!readOnly && (
          <Button variant="ghost" size="sm" onClick={() => emit([...value, ''])}>
            <Icon icon={PlusIcon} size="xs" />
            Add item
          </Button>
        )}
      </Container>
    );
  }

  return (
    <ScalarField label={null} value={value} readOnly={readOnly} onChange={emit} />
  );
};
