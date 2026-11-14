// packages/ui/show/inspector-sidebar/InspectorSidebar.tsx

'use client';

import React from 'react';
import { Button } from '../button';
import { Container } from '../container';
import { Spinner } from '../spinner';
import { Text } from '../text';
import { StructuredValueEditor } from '../structured-value-editor';
import { TuningControl, type TuningSetting, type TuningValue } from '../tuning-panel';
import {
  stampInspectionRef,
  substituteWriteInput,
  type InspectionSource,
  type InspectionWriteDescriptor,
} from '../inspection-ref';

import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
export interface InspectorFieldEditorProps {
  readonly value: unknown;
  readonly pending: boolean;
  readonly commit: (next: unknown) => void;
}

/** What `loadRecord` returns: the record plus the read-time CAS `basis` the host
 *  will guard the write against. `basis` is OPAQUE to the sidebar (a payload hash,
 *  a version token, whatever the host's write path understands) — the sidebar only
 *  carries it back to `dispatchWrite` so a concurrent edit fails closed. A plain
 *  record (no basis) means an unguarded, single-writer write. */
export interface InspectorRecordSnapshot {
  readonly record: unknown;
  readonly basis?: unknown;
}

export interface InspectorSidebarProps {
  readonly sources: readonly InspectionSource[];
  readonly loadRecord: (recordAddress: string) => Promise<InspectorRecordSnapshot>;
  readonly dispatchWrite: (
    write: InspectionWriteDescriptor,
    input: Record<string, unknown>,
    source: InspectionSource,
    /** The read-time CAS basis from loadRecord — the host guards the write on it. */
    basis?: unknown,
  ) => Promise<unknown>;
  readonly onClose: () => void;
  /** null: the host draws the frame (its own window with a title and a way to close), so only the sources are drawn. */
  readonly title?: string | null;
  /** Host-injected shape→editor capability registry (L090). Given a source's
   *  self-describing `shape`, the mount returns the matching editor bound to the
   *  inspector's `{value, pending, commit}` — this is the ONE editor mechanism,
   *  injected so `ui` never names a shape and a new shape is DATA, not core code.
   *  Return null to fall through to `renderFieldEditor` then the built-ins. */
  readonly editorForShape?: (
    shape: string | undefined,
    props: InspectorFieldEditorProps,
  ) => React.ReactNode | null;
  /** Host-injected per-source editor override; return null to use the built-ins.
   *  Tried after `editorForShape` — for sources that need full source-aware control. */
  readonly renderFieldEditor?: (
    source: InspectionSource,
    props: InspectorFieldEditorProps,
  ) => React.ReactNode | null;
  readonly emptyText?: string;
  readonly computedText?: string;
  readonly unlabeledText?: string;
  readonly logger?: Pick<Console, 'info' | 'error'>;
}

function valueAtPath(record: unknown, path: readonly string[] | undefined): unknown {
  if (!path || path.length === 0) return record;
  let node: unknown = record;
  for (const key of path) {
    if (node == null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

function setAtPath(record: unknown, path: readonly string[], next: unknown): unknown {
  if (path.length === 0) return next;
  const [head, ...rest] = path;
  const base = Array.isArray(record)
    ? [...record]
    : { ...((record ?? {}) as Record<string, unknown>) };
  (base as Record<string, unknown>)[head] = setAtPath(
    (base as Record<string, unknown>)[head],
    rest,
    next,
  );
  return base;
}

/** L114: labels come from descriptor DATA only. A source without a human label
 *  renders a neutral heading — internals (addresses) NEVER become UI copy. */
function sectionLabel(source: InspectionSource, unlabeledText: string): string {
  return source.label && source.label.trim().length > 0 ? source.label : unlabeledText;
}

/** How long after the last move a value is kept: a drag or a typed word sends one write, not one per move. */
const KEEP_AFTER_MS = 350;

/** The setting row a plain value is drawn with: the source's own, else read from the value itself. */
function settingFor(source: InspectionSource, value: unknown, label: string): TuningSetting {
  const inferred = typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value) ? 'color'
    : typeof value === 'number' ? 'number'
    : typeof value === 'boolean' ? 'toggle'
    : 'words';
  return { widget: inferred, ...(source.setting ?? {}), key: 'value', label } as TuningSetting;
}
function SourceSection({
  source,
  loadRecord,
  dispatchWrite,
  editorForShape,
  renderFieldEditor,
  computedText,
  unlabeledText,
  logger,
}: {
  source: InspectionSource;
  loadRecord: InspectorSidebarProps['loadRecord'];
  dispatchWrite: InspectorSidebarProps['dispatchWrite'];
  editorForShape: InspectorSidebarProps['editorForShape'];
  renderFieldEditor: InspectorSidebarProps['renderFieldEditor'];
  computedText: string;
  unlabeledText: string;
  logger: Pick<Console, 'info' | 'error'>;
}) {
  const [record, setRecord] = React.useState<unknown>(undefined);
  // The read-time CAS basis, held so the write can guard on the value the user
  // actually edited — a concurrent change to the same record fails closed.
  const basisRef = React.useRef<unknown>(undefined);
  const [loading, setLoading] = React.useState(true);
  const [pending, setPending] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    setLoading(true);
    loadRecord(source.recordAddress)
      .then((snapshot) => {
        if (!alive) return;
        setRecord(snapshot?.record);
        basisRef.current = snapshot?.basis;
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setFailure(errorWords(error));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [loadRecord, source.recordAddress]);

  const value = valueAtPath(record, source.fieldPath);
  const editable = !!source.write;

  const commit = (next: unknown) => {
    const write = source.write;
    if (!write) return;
    const nextRecord = source.fieldPath?.length
      ? setAtPath(record, source.fieldPath, next)
      : next;
    const input = substituteWriteInput(write.inputTemplate, {
      value: next,
      record: nextRecord,
      parts: {},
    });
    setPending(true);
    setFailure(null);
    dispatchWrite(write, input, source, basisRef.current)
      .then(() => {
        setRecord(nextRecord);
        // The write succeeded against the held basis; the host's re-read (or the
        // returned value) is the new basis. Clear it so a follow-up edit re-reads
        // rather than guarding on a now-stale token.
        basisRef.current = undefined;
        setPending(false);
        logger.info(`[inspector] write ok ${write.definitionId ?? source.recordAddress}`);
      })
      .catch((error: unknown) => {
        setPending(false);
        setFailure(errorWords(error));
        logger.error(`[inspector] write failed ${write.definitionId ?? source.recordAddress}`, error);
      });
  };

  // A plain value changes on screen at every move and is kept once the moves stop.
  const [draft, setDraft] = React.useState<{ value: unknown } | null>(null);
  const keepTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => () => clearTimeout(keepTimer.current), []);
  const change = (next: unknown) => {
    const held = { value: next };
    setDraft(held);
    clearTimeout(keepTimer.current);
    keepTimer.current = setTimeout(() => {
      commit(next);
      setDraft(current => (current === held ? null : current));
    }, KEEP_AFTER_MS);
  };

  const editorProps: InspectorFieldEditorProps = { value, pending, commit };
  // Blind shape dispatch first (the injected registry), then per-source override.
  const injected =
    editorForShape?.(source.shape, editorProps) ?? renderFieldEditor?.(source, editorProps) ?? null;
  // A source with its own setting row is drawn by that row's control whatever its value's shape (a shadow is an object).
  const isStructured = !source.setting?.widget && value !== null && typeof value === 'object';

  const label = sectionLabel(source, unlabeledText);
  const plain = editable && !injected && !isStructured && !loading && !(record === undefined && failure);
  return (
    <Container gap="xs" padding="sm" border="bottom" data-inspector-section={source.recordAddress}>
      {plain ? null : <Text variant="heading-xs">{label}</Text>}
      {loading ? (
        <Spinner size="sm" />
      ) : record === undefined && failure ? (
        <Text variant="body-xs" color="error">{failure}</Text>
      ) : !editable ? (
        <Container gap="xs">
          {isStructured ? (
            <StructuredValueEditor value={value} readOnly />
          ) : (
            <Text variant="body" color="muted">{value == null ? '—' : String(value)}</Text>
          )}
          <Text variant="label">{computedText}</Text>
        </Container>
      ) : injected ? (
        <>{injected}</>
      ) : isStructured ? (
        <StructuredValueEditor value={value} onChange={commit} readOnly={pending} />
      ) : (
        <TuningControl
          setting={settingFor(source, value, label)}
          value={(draft ? draft.value : value) as TuningValue}
          onChange={(_key, next) => change(next)}
        />
      )}
      {pending ? <Text variant="label">Saving…</Text> : null}
      {!loading && record !== undefined && failure ? (
        <Text variant="body-xs" color="error">{failure}</Text>
      ) : null}
    </Container>
  );
}

export function InspectorSidebar({
  sources,
  loadRecord,
  dispatchWrite,
  onClose,
  title = 'Edit',
  editorForShape,
  renderFieldEditor,
  emptyText = 'Nothing to edit here.',
  computedText = 'Shown from saved data — not directly editable.',
  unlabeledText = 'Details',
  logger = console,
}: InspectorSidebarProps) {
  React.useEffect(() => {
    logger.info(`[inspector] resolved ${sources.length} sources`);
  }, [logger, sources.length]);

  return (
    <Container
      gap="sm"
      padding={title === null ? 'none' : 'sm'}
      border={title === null ? 'none' : 'all'}
      overflow="y-auto"
      height="full"
      width="full"
      data-floating-layer="true"
      {...stampInspectionRef({ family: 'inspector', parts: {} })}
    >
      {title === null ? null : (
        <Container layout="horizontal" alignItems="center" justifyContent="between" gap="sm">
          <Text variant="heading">{title}</Text>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">✕</Button>
        </Container>
      )}
      {sources.length === 0 ? (
        <Text variant="body" color="muted">{emptyText}</Text>
      ) : (
        sources.map((source, index) => (
          <SourceSection
            key={`${source.recordAddress}:${(source.fieldPath ?? []).join('.')}:${index}`}
            source={source}
            loadRecord={loadRecord}
            dispatchWrite={dispatchWrite}
            editorForShape={editorForShape}
            renderFieldEditor={renderFieldEditor}
            computedText={computedText}
            unlabeledText={unlabeledText}
            logger={logger}
          />
        ))
      )}
    </Container>
  );
}
