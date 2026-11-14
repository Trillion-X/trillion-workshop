import React from 'react';
import { Button } from '../button';
import { Text } from '../text';
import { Textarea, useControlledTextSelection } from '../input';

export type ExpressionComposerState =
  | 'editing'
  | 'analyzing'
  | 'valid'
  | 'invalid'
  | 'previewing'
  | 'saving'
  | 'saved'
  | 'conflict'
  | 'stale'
  | 'read-only';

export interface ExpressionSourceSpan {
  startUtf16: number;
  endUtf16: number;
}

export interface ExpressionCompletionItem {
  id: string;
  label: string;
  detail?: string;
  group?: string;
  /** Stable caller-owned identity for the category/group containing this item. */
  groupId?: string;
  kind?: string;
  category?: string;
  signature?: string;
  currentArgument?: string | number;
  help?: string;
  summary?: string;
  disabled?: boolean;
  insertionText: string;
  replacementSpan: ExpressionSourceSpan;
  postInsertCaretUtf16: number;
}

export interface ExpressionReferenceItem {
  id: string;
  label: string;
  detail?: string;
  insertionText: string;
}

export interface ExpressionDiagnosticItem {
  id: string;
  /** Stable machine-readable diagnostic identity supplied by the expression owner. */
  code?: string;
  severity: 'incomplete' | 'error' | 'warning' | 'info';
  title: string;
  cause?: string;
  repair?: string;
  action?: ExpressionDiagnosticAction;
  span: ExpressionSourceSpan;
}

export interface ExpressionDiagnosticAction {
  id: string;
  label: string;
  disabled?: boolean;
}

export interface ExpressionExplanationSection {
  id: string;
  label: string;
  content: React.ReactNode;
}

/**
 * Caller-owned content that remains visible while the composer is mounted.
 * This is intentionally separate from optional, disclosure-gated explanation.
 */
export interface ExpressionComposerContentSlot {
  id: string;
  label?: string;
  content: React.ReactNode;
  referenceIds?: readonly string[];
}

/** Semantic result state. `content` is visual; `id`/`value` are stable evidence. */
export interface ExpressionComposerResult {
  id?: string;
  value?: string | number | boolean | null;
  content: React.ReactNode;
}

/** Caller-owned transaction summary; the composer never invents undo history. */
export interface ExpressionComposerUndoState {
  topTransactionId?: string;
  transactionCount: number;
}

/**
 * Input-capability copy rendered through pointer-modality CSS rather than a
 * product- or viewport-specific JavaScript branch.
 */
export interface ExpressionComposerModalityHelp {
  hardware?: React.ReactNode;
  touch?: React.ReactNode;
  shortcut?: React.ReactNode;
  shortcutLabel?: string;
}

export interface ExpressionComposerLabels {
  bar: string;
  details: string;
  help: string;
  signature: string;
  argument: string;
  resultRegion: string;
  result: string;
  checking: string;
  commit: string;
  cancel: string;
  chooseReference: string;
  stopChoosing: string;
  retry: string;
  explain: string;
  hideExplanation: string;
  references: string;
  functions: string;
  noSuggestions: string;
}

export interface ExpressionComposerSemanticNodeIds {
  bar: string;
  details: string;
  help: string;
  signature: string;
  argument: string;
  activeHelp: string;
  result: string;
  content: string;
  checking: string;
}

export interface ExpressionComposerTestIds {
  bar?: string;
  details?: string;
  help?: string;
  signature?: string;
  argument?: string;
  activeHelp?: string;
  listbox?: string;
  activeOption?: string;
  diagnostic?: string;
  diagnosticActionPrefix?: string;
  result?: string;
  checkingStatus?: string;
  explain?: string;
  commit?: string;
  cancel?: string;
  referenceOverlay?: string;
}

export interface ExpressionSourceChange {
  source: string;
  selection: readonly [number, number];
  reason: 'input' | 'completion' | 'reference';
  itemId?: string;
}

export type ExpressionPostCommitMoveIntent = 'none' | 'next' | 'previous';

export type ExpressionCommitTrigger =
  | 'button'
  | 'enter'
  | 'modified-enter'
  | 'tab'
  | 'shift-tab';

export interface ExpressionCommitRequest {
  trigger: ExpressionCommitTrigger;
  moveIntent: ExpressionPostCommitMoveIntent;
}

export interface ExpressionCommitAcceptance {
  accepted: boolean;
  readbackIdentity?: string;
}

export type ExpressionCommitOutcome =
  | void
  | boolean
  | ExpressionCommitAcceptance
  | Promise<void | boolean | ExpressionCommitAcceptance>;

export interface ExpressionCommitMoveIntents {
  enter?: ExpressionPostCommitMoveIntent;
  modifiedEnter?: ExpressionPostCommitMoveIntent;
  tab?: ExpressionPostCommitMoveIntent;
  shiftTab?: ExpressionPostCommitMoveIntent;
}

export interface ExpressionComposerProps {
  source: string;
  selection: readonly [number, number];
  state: ExpressionComposerState;
  /**
   * Stable owner identity for one mounted expression instance. Callers should
   * use their durable cell/item identity. The legacy fallback exists only so
   * older generic callers keep rendering while they adopt durable identity.
   */
  instanceId?: string;
  cellIdentity?: string;
  sourceTestId?: string;
  testIds?: ExpressionComposerTestIds;
  overlayOwnerId?: string;
  humanCellLabel?: string;
  accessibleLabel: string;
  description: string;
  sourcePrefix?: string;
  /** Stable revision of the owner-supplied completion/reference catalog. */
  catalogRevision?: string;
  completionItems?: readonly ExpressionCompletionItem[];
  referenceItems?: readonly ExpressionReferenceItem[];
  diagnostics?: readonly ExpressionDiagnosticItem[];
  /** Persistent caller-owned details (for example, an ordered dependency list). */
  contentSlot?: ExpressionComposerContentSlot;
  /** Structured semantic result; preferred over the compatibility `preview` prop. */
  result?: ExpressionComposerResult;
  /** Compatibility visual result for existing callers. */
  preview?: React.ReactNode;
  explanationSections?: readonly ExpressionExplanationSection[];
  modalityHelp?: ExpressionComposerModalityHelp;
  undoState?: ExpressionComposerUndoState;
  /** Independent detail-body scroll cap. */
  detailsMaxBlockSize?: React.CSSProperties['maxBlockSize'];
  announcement?: string;
  labels: ExpressionComposerLabels;
  semanticNodeIds: ExpressionComposerSemanticNodeIds;
  readOnly?: boolean;
  referencePicking?: boolean;
  onSourceChange: (change: ExpressionSourceChange) => void;
  onSelectionChange: (selection: readonly [number, number]) => void;
  onAnalyze?: () => void;
  onCommit: (request?: ExpressionCommitRequest) => ExpressionCommitOutcome;
  commitMoveIntents?: ExpressionCommitMoveIntents;
  onMoveAfterCommit?: (
    intent: Exclude<ExpressionPostCommitMoveIntent, 'none'>,
    acceptance: ExpressionCommitAcceptance,
  ) => void;
  onCancel: () => void;
  onRetry?: () => void;
  onDiagnosticAction?: (
    diagnostic: ExpressionDiagnosticItem,
    action: ExpressionDiagnosticAction,
  ) => void;
  onReferencePickingChange?: (active: boolean) => void;
  onReferencePick?: (item: ExpressionReferenceItem) => void;
  onUndo?: () => void;
}

export function replaceExpressionSpan(
  source: string,
  span: ExpressionSourceSpan,
  insertionText: string,
): string {
  const start = clampOffset(span.startUtf16, source.length);
  const end = clampOffset(Math.max(start, span.endUtf16), source.length);
  return `${source.slice(0, start)}${insertionText}${source.slice(end)}`;
}

export function applyExpressionCompletion(
  source: string,
  item: ExpressionCompletionItem,
): { source: string; selection: readonly [number, number] } {
  const nextSource = replaceExpressionSpan(source, item.replacementSpan, item.insertionText);
  const caret = clampOffset(item.postInsertCaretUtf16, nextSource.length);
  return { source: nextSource, selection: [caret, caret] };
}

export function insertExpressionReference(
  source: string,
  selection: readonly [number, number],
  item: ExpressionReferenceItem,
): { source: string; selection: readonly [number, number] } {
  const start = clampOffset(Math.min(selection[0], selection[1]), source.length);
  const end = clampOffset(Math.max(selection[0], selection[1]), source.length);
  const nextSource = `${source.slice(0, start)}${item.insertionText}${source.slice(end)}`;
  const caret = start + item.insertionText.length;
  return { source: nextSource, selection: [caret, caret] };
}

export function ExpressionComposer({
  source,
  selection,
  state,
  instanceId: suppliedInstanceId,
  cellIdentity,
  sourceTestId,
  testIds = {},
  overlayOwnerId,
  humanCellLabel,
  accessibleLabel,
  description,
  sourcePrefix = '=',
  catalogRevision,
  completionItems = [],
  referenceItems = [],
  diagnostics = [],
  contentSlot,
  result,
  preview,
  explanationSections = [],
  modalityHelp,
  undoState,
  detailsMaxBlockSize = 'min(32rem, 60dvh)',
  announcement,
  labels,
  semanticNodeIds,
  readOnly = false,
  referencePicking = false,
  onSourceChange,
  onSelectionChange,
  onAnalyze,
  onCommit,
  commitMoveIntents,
  onMoveAfterCommit,
  onCancel,
  onRetry,
  onDiagnosticAction,
  onReferencePickingChange,
  onReferencePick,
  onUndo,
}: ExpressionComposerProps) {
  const inputRef = useControlledTextSelection<HTMLTextAreaElement>(source, selection);
  const legacyInstanceId = React.useId();
  const instanceId = suppliedInstanceId?.trim() || `expression-${legacyInstanceId}`;
  const inputId = `${instanceId}-source`;
  const helpId = `${instanceId}-help`;
  const listboxId = `${instanceId}-listbox`;
  const statusId = `${instanceId}-status`;
  const errorId = `${instanceId}-error`;
  const diagnosticId = `${instanceId}-diagnostics`;
  const [completionOpen, setCompletionOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(() =>
    firstEnabledCompletionIndex(completionItems));
  const [explanationOpen, setExplanationOpen] = React.useState(false);
  const activeCompletion =
    activeIndex >= 0 && !completionItems[activeIndex]?.disabled
      ? completionItems[activeIndex] ?? null
      : null;
  const activeHelp =
    activeCompletion?.help ?? activeCompletion?.summary ?? activeCompletion?.detail;
  const resultContent = result?.content ?? preview;
  const inputModalityHelp: ExpressionComposerModalityHelp = modalityHelp ?? {
    shortcut: 'F2',
    shortcutLabel: 'Edit shortcut',
  };
  const commitSequenceRef = React.useRef(0);
  const blockingDiagnostics = diagnostics.filter((item) => item.severity === 'error');
  const blockingAnnouncement = joinAnnouncementPhrases(
    uniquePhrases(blockingDiagnostics.flatMap(
      (item) => [item.title, item.cause, item.repair, item.action?.label],
    )),
  );
  const statusAnnouncement = useDistinctLiveMessage(
    announcement ?? (state === 'analyzing' ? labels.checking : humanizeComposerState(state)),
  );
  const errorAnnouncement = useDistinctLiveMessage(blockingAnnouncement);
  const moveIntents: Required<ExpressionCommitMoveIntents> = {
    enter: commitMoveIntents?.enter ?? 'none',
    modifiedEnter: commitMoveIntents?.modifiedEnter ?? 'none',
    tab: commitMoveIntents?.tab ?? 'next',
    shiftTab: commitMoveIntents?.shiftTab ?? 'previous',
  };
  const completionRuns = groupCompletionRuns(completionItems);

  React.useEffect(() => {
    setActiveIndex((current) => normalizeActiveCompletionIndex(completionItems, current));
    if (completionItems.length === 0 || readOnly) setCompletionOpen(false);
  }, [completionItems, readOnly]);

  const selectCompletion = React.useCallback((item: ExpressionCompletionItem) => {
    if (item.disabled) return;
    const next = applyExpressionCompletion(source, item);
    onSourceChange({ ...next, reason: 'completion', itemId: item.id });
    setCompletionOpen(false);
    queueMicrotask(() => inputRef.current?.focus());
  }, [onSourceChange, source]);

  const selectReference = React.useCallback((item: ExpressionReferenceItem) => {
    if (onReferencePick) {
      onReferencePick(item);
    } else {
      const next = insertExpressionReference(source, selection, item);
      onSourceChange({ ...next, reason: 'reference', itemId: item.id });
    }
    queueMicrotask(() => inputRef.current?.focus());
  }, [onReferencePick, onSourceChange, selection, source]);

  const requestCommit = React.useCallback((
    trigger: ExpressionCommitTrigger,
    moveIntent: ExpressionPostCommitMoveIntent,
  ) => {
    const sequence = ++commitSequenceRef.current;
    let outcome: ExpressionCommitOutcome;
    try {
      outcome = onCommit({ trigger, moveIntent });
    } catch {
      return;
    }
    if (moveIntent === 'none') return;

    void Promise.resolve(outcome).then((resolved) => {
      if (sequence !== commitSequenceRef.current) return;
      const acceptance = normalizeCommitAcceptance(resolved);
      if (!acceptance?.accepted) return;
      onMoveAfterCommit?.(moveIntent, acceptance);
    }).catch(() => {
      // The owner retains focus and source on a rejected/failed commit.
    });
  }, [onCommit, onMoveAfterCommit]);

  const describedBy = [
    helpId,
    statusId,
    blockingDiagnostics.length > 0 ? errorId : null,
  ].filter(Boolean).join(' ');
  const blocked = readOnly || state === 'saving';

  return (
    <section
      data-expression-state={state}
      data-expression-instance-id={instanceId}
      data-cell-identity={cellIdentity}
      data-human-cell-label={humanCellLabel}
      data-catalog-revision={catalogRevision}
      data-reference-ids={referenceItems.length > 0
        ? JSON.stringify(referenceItems.map((item) => item.id))
        : undefined}
      data-undo-top-transaction-id={undoState?.topTransactionId}
      data-undo-transaction-count={undoState?.transactionCount}
      data-result-id={result?.id}
      data-result-value={semanticAttributeValue(result?.value)}
      data-result-present={resultContent !== undefined ? 'true' : 'false'}
      aria-label={accessibleLabel}
      className="flex w-full min-w-0 flex-col rounded-[var(--radius-xl)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] shadow-[var(--shadow-lg)]"
    >
      <div
        role="region"
        aria-label={labels.bar}
        data-testid={testIds.bar}
        data-ui-node={semanticNodeIds.bar}
        data-cell-key={cellIdentity}
        className="sticky top-0 z-10 flex min-w-0 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-2"
      >
        <Text variant="caption" color="muted" aria-hidden="true">{sourcePrefix}</Text>
        <div className="min-w-0 flex-1">
          <Textarea
            ref={inputRef}
            id={inputId}
            data-testid={sourceTestId}
            data-expression-instance-id={instanceId}
            data-cell-identity={cellIdentity}
            data-cell-key={cellIdentity}
            data-highlighted-span-utf16={JSON.stringify(selection)}
            data-human-cell-label={humanCellLabel}
            data-catalog-revision={catalogRevision}
            data-active-completion-id={activeCompletion?.id}
            data-active-signature={activeCompletion?.signature}
            data-active-current-argument={
              semanticAttributeValue(activeCompletion?.currentArgument)
            }
            data-active-help={activeHelp}
            role="combobox"
            aria-label={accessibleLabel}
            aria-describedby={describedBy}
            aria-controls={listboxId}
            aria-expanded={readOnly ? false : completionOpen}
            aria-autocomplete="list"
            aria-activedescendant={
              !readOnly && completionOpen && activeCompletion
                ? completionOptionId(instanceId, activeCompletion.id)
                : undefined
            }
            aria-readonly={readOnly || undefined}
            aria-invalid={blockingDiagnostics.length > 0 || undefined}
            aria-busy={state === 'analyzing' || state === 'saving' || undefined}
            value={source}
            readOnly={blocked}
            rows={1}
            autoGrow
            maxHeight={168}
            borderless
            className="min-h-11 font-mono text-[length:var(--text-body-size)] leading-[var(--line-body)]"
            onFocus={() => {
              if (!readOnly) setCompletionOpen(completionItems.length > 0);
            }}
            onChange={(event) => {
              const nextSource = event.currentTarget.value;
              const caret = event.currentTarget.selectionStart;
              onSourceChange({
                source: nextSource,
                selection: [caret, event.currentTarget.selectionEnd],
                reason: 'input',
              });
              setCompletionOpen(completionItems.length > 0);
            }}
            onSelect={(event) => {
              onSelectionChange([
                event.currentTarget.selectionStart,
                event.currentTarget.selectionEnd,
              ]);
            }}
            onKeyDown={(event) => {
              if (readOnly) {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  onCancel();
                }
                return;
              }
              if (event.key === 'ArrowDown' && completionItems.length > 0) {
                event.preventDefault();
                setCompletionOpen(true);
                setActiveIndex((current) =>
                  nextEnabledCompletionIndex(completionItems, current, 1));
                return;
              }
              if (event.key === 'ArrowUp' && completionItems.length > 0) {
                event.preventDefault();
                setCompletionOpen(true);
                setActiveIndex((current) =>
                  nextEnabledCompletionIndex(completionItems, current, -1));
                return;
              }
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                requestCommit('modified-enter', moveIntents.modifiedEnter);
                return;
              }
              if (event.key === 'Tab' && event.shiftKey && completionOpen) {
                event.preventDefault();
                setCompletionOpen(false);
                return;
              }
              if ((event.key === 'Enter' || event.key === 'Tab') && completionOpen && activeCompletion) {
                event.preventDefault();
                selectCompletion(activeCompletion);
                return;
              }
              if (event.key === 'Enter') {
                event.preventDefault();
                requestCommit('enter', moveIntents.enter);
                return;
              }
              if (event.key === 'Tab') {
                event.preventDefault();
                requestCommit(
                  event.shiftKey ? 'shift-tab' : 'tab',
                  event.shiftKey ? moveIntents.shiftTab : moveIntents.tab,
                );
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                if (completionOpen) {
                  setCompletionOpen(false);
                } else if (referencePicking) {
                  onUndo?.();
                  onReferencePickingChange?.(false);
                } else {
                  onCancel();
                }
                return;
              }
              if (event.key.toLowerCase() === 'z' && (event.metaKey || event.ctrlKey) && referencePicking && onUndo) {
                event.preventDefault();
                onUndo();
              }
            }}
          />
        </div>
        {!readOnly && inputModalityHelp.shortcut !== undefined ? (
          <kbd
            aria-label={inputModalityHelp.shortcutLabel ?? 'Keyboard shortcut'}
            data-input-modality-help="hardware"
            className="inline-flex items-center justify-center rounded border border-[var(--border-secondary)] bg-[var(--glass-bg-hover)] px-2 py-0.5 font-mono text-xs text-[var(--text-secondary)] [@media(pointer:coarse)]:hidden"
          >
            {inputModalityHelp.shortcut}
          </kbd>
        ) : null}
      </div>

      <div
        role="region"
        aria-label={labels.details}
        data-testid={testIds.details}
        data-ui-node={semanticNodeIds.details}
        data-catalog-revision={catalogRevision}
        data-undo-top-transaction-id={undoState?.topTransactionId}
        data-undo-transaction-count={undoState?.transactionCount}
        className="min-h-0 overflow-y-auto overscroll-contain"
        style={{ maxBlockSize: detailsMaxBlockSize }}
      >
      <Text
        id={helpId}
        as="p"
        variant="caption"
        color="muted"
        aria-label={labels.help}
        data-testid={testIds.help}
        data-ui-node={semanticNodeIds.help}
        data-catalog-revision={catalogRevision}
        data-active-completion-id={activeCompletion?.id}
        data-active-signature={activeCompletion?.signature}
        data-active-current-argument={semanticAttributeValue(activeCompletion?.currentArgument)}
        data-active-help={activeHelp}
        className="px-3 pt-2"
      >
        <span>{description}</span>
        {inputModalityHelp.hardware !== undefined ? (
          <span
            data-input-modality-help="hardware"
            className="ml-2 [@media(pointer:coarse)]:hidden"
          >
            {inputModalityHelp.hardware}
          </span>
        ) : null}
        {inputModalityHelp.touch !== undefined ? (
          <span
            data-input-modality-help="touch"
            className="ml-2 hidden [@media(pointer:coarse)]:inline"
          >
            {inputModalityHelp.touch}
          </span>
        ) : null}
        {activeCompletion?.signature ? (
          <span
            className="ml-2"
            aria-label={labels.signature}
            data-testid={testIds.signature}
            data-ui-node={semanticNodeIds.signature}
            data-active-signature={activeCompletion.signature}
            data-active-current-argument={
              semanticAttributeValue(activeCompletion.currentArgument)
            }
            data-active-help={activeHelp}
          >
            {activeCompletion.signature}
            {activeCompletion.currentArgument !== undefined
              ? (
                  <span
                    aria-label={labels.argument}
                    data-testid={testIds.argument}
                    data-ui-node={semanticNodeIds.argument}
                    data-active-current-argument={
                      semanticAttributeValue(activeCompletion.currentArgument)
                    }
                  >
                    {` — ${String(activeCompletion.currentArgument)}`}
                  </span>
                )
              : ''}
            {activeHelp ? (
              <span
                aria-label={labels.help}
                data-testid={testIds.activeHelp}
                data-ui-node={semanticNodeIds.activeHelp}
                data-active-help={activeHelp}
                className="ml-2"
              >
                {activeHelp}
              </span>
            ) : null}
          </span>
        ) : null}
      </Text>

      <div
        id={listboxId}
        data-testid={testIds.listbox ?? (sourceTestId ? `${sourceTestId}-listbox` : undefined)}
        data-catalog-revision={catalogRevision}
        data-active-completion-id={activeCompletion?.id}
        role="listbox"
        aria-label={labels.functions}
        hidden={readOnly || !completionOpen}
        className="mx-3 mt-2 max-h-52 overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-overlay)] p-1"
      >
        {completionItems.length === 0 ? (
          <Text variant="caption" color="muted" className="block px-2 py-2">
            {labels.noSuggestions}
          </Text>
        ) : completionRuns.map((run) => {
          const options = run.items.map(({ item, index }) => {
            const selected = completionOpen && index === activeIndex && !item.disabled;
            return (
              <div
                key={item.id}
                id={completionOptionId(instanceId, item.id)}
                data-testid={
                  selected && testIds.activeOption
                    ? testIds.activeOption
                    : sourceTestId ? `${sourceTestId}-option-${encodeURIComponent(item.id)}` : undefined
                }
                data-option-id={item.id}
                data-option-disabled={item.disabled ? 'true' : 'false'}
                data-option-group={item.group ?? ''}
                data-option-group-id={item.groupId ?? ''}
                data-option-kind={item.kind ?? ''}
                data-option-category={item.category ?? ''}
                data-option-signature={item.signature ?? ''}
                data-option-current-argument={item.currentArgument ?? ''}
                data-option-help={item.help ?? item.summary ?? item.detail ?? ''}
                data-option-summary={item.summary ?? item.detail ?? ''}
                role="option"
                aria-selected={selected}
                aria-disabled={item.disabled || undefined}
                className={`cursor-default rounded-[var(--radius-md)] px-2 py-2 ${selected ? 'bg-[var(--surface-selected)]' : ''} ${item.disabled ? 'opacity-50' : ''}`}
                onPointerMove={() => {
                  if (!item.disabled) setActiveIndex(index);
                }}
                onPointerDown={(event) => {
                  event.preventDefault();
                  selectCompletion(item);
                }}
              >
                <span className="flex min-w-0 items-baseline gap-2">
                  <Text variant="body" weight="medium">{item.label}</Text>
                  {item.category ? (
                    <Text as="span" variant="caption" color="muted">{item.category}</Text>
                  ) : null}
                </span>
                {item.signature ? (
                  <Text as="p" variant="caption" className="mt-0.5">
                    {item.signature}
                    {item.currentArgument !== undefined
                      ? ` — ${String(item.currentArgument)}`
                      : ''}
                  </Text>
                ) : null}
                {item.summary ?? item.detail ? (
                  <Text as="p" variant="caption" color="muted" className="mt-0.5">
                    {item.summary ?? item.detail}
                  </Text>
                ) : null}
              </div>
            );
          });

          if (!run.group) {
            return <React.Fragment key={run.runId}>{options}</React.Fragment>;
          }
          return (
            <div
              key={run.runId}
              id={`${instanceId}-category-${encodeURIComponent(run.runId)}`}
              role="group"
              aria-label={run.group}
              data-option-group={run.group}
              data-category-id={run.groupId}
              data-category-run-id={run.runId}
            >
              <Text
                as="p"
                variant="caption"
                color="muted"
                className="px-2 pb-1 pt-2"
                aria-hidden="true"
              >
                {run.group}
              </Text>
              {options}
            </div>
          );
        })}
      </div>

      {diagnostics.length > 0 ? (
        <div
          id={diagnosticId}
          data-source-span-utf16={JSON.stringify([
            diagnostics[0]!.span.startUtf16,
            diagnostics[0]!.span.endUtf16,
          ])}
          className="mx-3 mt-2 space-y-1"
          aria-label="Issues"
        >
          {diagnostics.map((item) => (
            <div
              key={item.id}
              id={`${instanceId}-diagnostic-${encodeURIComponent(item.id)}`}
              data-source-span-utf16={JSON.stringify([item.span.startUtf16, item.span.endUtf16])}
              data-diagnostic-id={item.id}
              data-diagnostic-code={item.code}
              data-diagnostic-severity={item.severity}
              data-diagnostic-span-start-utf16={item.span.startUtf16}
              data-diagnostic-span-end-utf16={item.span.endUtf16}
              data-diagnostic-action-id={item.action?.id}
              className="flex w-full items-start gap-2 rounded-[var(--radius-md)] bg-[var(--surface-danger-subtle)] px-2 py-2"
            >
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => {
                  onSelectionChange([item.span.startUtf16, item.span.endUtf16]);
                  inputRef.current?.focus();
                }}
              >
                <Text variant="body" weight="medium">{item.title}</Text>
                {item.cause ? <Text as="span" variant="caption" color="muted" className="ml-2">{item.cause}</Text> : null}
                {item.repair ? <Text as="span" variant="caption" className="ml-2">{item.repair}</Text> : null}
              </button>
              {item.action ? (
                <Button
                  variant="ghost"
                  size="sm"
                  data-diagnostic-code={item.code}
                  data-diagnostic-action-id={item.action.id}
                  data-diagnostic-span-start-utf16={item.span.startUtf16}
                  data-diagnostic-span-end-utf16={item.span.endUtf16}
                  data-testid={testIds.diagnosticActionPrefix
                    ? `${testIds.diagnosticActionPrefix}${item.action.id}`
                    : undefined}
                  disabled={item.action.disabled || !onDiagnosticAction}
                  onClick={() => onDiagnosticAction?.(item, item.action!)}
                >
                  {item.action.label}
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {resultContent !== undefined ? (
        <div
          role="region"
          aria-label={labels.resultRegion}
          data-ui-node={semanticNodeIds.result}
          data-result-id={result?.id}
          data-result-value={semanticAttributeValue(result?.value)}
          data-testid={testIds.result}
          data-cell-key={cellIdentity}
          className="mx-3 mt-2 rounded-[var(--radius-lg)] bg-[var(--surface-sunken)] px-3 py-2"
        >
          <Text variant="caption" color="muted">{labels.result} </Text>
          <div className="mt-1 text-[length:var(--text-body-size)]">{resultContent}</div>
        </div>
      ) : null}

      {!readOnly && referenceItems.length > 0 && referencePicking ? (
        <div
          role="dialog"
          aria-modal="false"
          className="mx-3 mt-2"
          aria-label={labels.references}
          data-testid={testIds.referenceOverlay}
          data-overlay-owner-id={overlayOwnerId}
        >
          <div className="flex flex-wrap gap-1.5">
            {referenceItems.map((item) => (
              <Button
                key={item.id}
                variant="ghost"
                size="sm"
                targetRole="reference"
                data-reference-id={item.id}
                title={item.detail}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => selectReference(item)}
              >
                {item.label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      {contentSlot ? (
        <section
          id={`${instanceId}-content-${encodeURIComponent(contentSlot.id)}`}
          data-ui-node={semanticNodeIds.content}
          data-content-slot-id={contentSlot.id}
          data-reference-ids={contentSlot.referenceIds
            ? JSON.stringify(contentSlot.referenceIds)
            : undefined}
          aria-label={contentSlot.label}
          className="mx-3 mt-2"
        >
          {contentSlot.label ? (
            <Text variant="caption" weight="medium">{contentSlot.label}</Text>
          ) : null}
          <div className={contentSlot.label ? 'mt-1 text-[length:var(--text-body-size)]' : undefined}>
            {contentSlot.content}
          </div>
        </section>
      ) : null}

      {explanationOpen && explanationSections.length > 0 ? (
        <div className="mx-3 mt-2 space-y-2" aria-label="Explanation">
          {explanationSections.map((section) => (
            <section key={section.id} aria-labelledby={`${inputId}-${section.id}`}>
              <Text id={`${inputId}-${section.id}`} variant="caption" weight="medium">{section.label}</Text>
              <div className="mt-1 text-[length:var(--text-body-size)]">{section.content}</div>
            </section>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 px-3 py-3">
        {!readOnly && referenceItems.length > 0 ? (
          <Button
            variant={referencePicking ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => onReferencePickingChange?.(!referencePicking)}
          >
            {referencePicking ? labels.stopChoosing : labels.chooseReference}
          </Button>
        ) : null}
        {explanationSections.length > 0 ? (
          <Button data-testid={testIds.explain} variant="ghost" size="sm" onClick={() => setExplanationOpen((open) => !open)}>
            {explanationOpen ? labels.hideExplanation : labels.explain}
          </Button>
        ) : null}
        {!readOnly && onRetry && (state === 'invalid' || state === 'conflict' || state === 'stale') ? (
          <Button variant="ghost" size="sm" onClick={onRetry}>{labels.retry}</Button>
        ) : null}
        <span className="min-w-2 flex-1" />
        <Button data-testid={testIds.cancel} variant="ghost" size="sm" onClick={onCancel}>{labels.cancel}</Button>
        {!readOnly && state !== 'invalid' ? (
          <Button
            variant="primary"
            size="sm"
            data-testid={testIds.commit}
            disabled={blocked || state === 'analyzing'}
            onClick={() => requestCommit('button', 'none')}
          >
            {labels.commit}
          </Button>
        ) : null}
      </div>

      <div
        id={statusId}
        role="status"
        data-testid={sourceTestId ? `${sourceTestId}-status` : undefined}
        className="sr-only"
        aria-live="polite"
        aria-atomic="true"
      >
        {statusAnnouncement}
      </div>
      {state === 'analyzing' && testIds.checkingStatus ? (
        <div
          data-testid={testIds.checkingStatus}
          data-ui-node={semanticNodeIds.checking}
          aria-label={labels.checking}
          data-cell-key={cellIdentity}
          className="mx-3 pb-3 text-[length:var(--font-size-caption)] text-[var(--text-secondary)]"
        >
          {announcement || labels.checking}
        </div>
      ) : null}
      <div
        id={errorId}
        role="alert"
        data-testid={testIds.diagnostic ?? (sourceTestId ? `${sourceTestId}-error` : undefined)}
        data-source-span-utf16={blockingDiagnostics.length > 0
          ? JSON.stringify([
              blockingDiagnostics[0]!.span.startUtf16,
              blockingDiagnostics[0]!.span.endUtf16,
            ])
          : undefined}
        className="sr-only"
        aria-live={errorAnnouncement ? 'assertive' : 'off'}
        aria-atomic="true"
      >
        {errorAnnouncement}
      </div>
      </div>
    </section>
  );
}

function completionOptionId(instanceId: string, optionId: string): string {
  return `${instanceId}-option-${encodeURIComponent(optionId)}`;
}

interface ExpressionCompletionRun {
  group: string | null;
  groupId: string | null;
  runId: string;
  items: Array<{ item: ExpressionCompletionItem; index: number }>;
}

function groupCompletionRuns(
  items: readonly ExpressionCompletionItem[],
): ExpressionCompletionRun[] {
  const runs: ExpressionCompletionRun[] = [];
  items.forEach((item, index) => {
    const group = item.group?.trim() || null;
    const groupId = item.groupId?.trim() || group;
    const current = runs[runs.length - 1];
    if (!current || current.group !== group || current.groupId !== groupId) {
      const runId = item.groupId?.trim()
        ? item.groupId.trim()
        : `${group ?? 'ungrouped'}:${item.id}`;
      runs.push({ group, groupId, runId, items: [{ item, index }] });
      return;
    }
    current.items.push({ item, index });
  });
  return runs;
}

function firstEnabledCompletionIndex(items: readonly ExpressionCompletionItem[]): number {
  return items.findIndex((item) => !item.disabled);
}

function normalizeActiveCompletionIndex(
  items: readonly ExpressionCompletionItem[],
  current: number,
): number {
  if (current >= 0 && current < items.length && !items[current]?.disabled) return current;
  return firstEnabledCompletionIndex(items);
}

function nextEnabledCompletionIndex(
  items: readonly ExpressionCompletionItem[],
  current: number,
  direction: 1 | -1,
): number {
  if (items.length === 0) return -1;
  const first = normalizeActiveCompletionIndex(items, current);
  if (first < 0) return -1;
  for (let offset = 1; offset <= items.length; offset += 1) {
    const candidate = (first + direction * offset + items.length) % items.length;
    if (!items[candidate]?.disabled) return candidate;
  }
  return first;
}

function normalizeCommitAcceptance(
  outcome: void | boolean | ExpressionCommitAcceptance,
): ExpressionCommitAcceptance | null {
  if (outcome === true) return { accepted: true };
  if (outcome === false || outcome == null) return null;
  return typeof outcome === 'object' ? outcome : null;
}

function uniquePhrases(values: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const phrases: string[] = [];
  for (const value of values) {
    const phrase = value?.trim();
    if (!phrase || seen.has(phrase)) continue;
    seen.add(phrase);
    phrases.push(phrase);
  }
  return phrases;
}

function joinAnnouncementPhrases(phrases: readonly string[]): string {
  return phrases.map((phrase) => /[.!?]$/u.test(phrase) ? phrase : `${phrase}.`).join(' ');
}

function humanizeComposerState(state: ExpressionComposerState): string {
  switch (state) {
    case 'analyzing':
      return 'Checking';
    case 'saving':
      return 'Saving';
    case 'saved':
      return 'Saved';
    case 'conflict':
      return 'Save conflict; draft kept';
    case 'stale':
      return 'Result is stale';
    default:
      return '';
  }
}

function useDistinctLiveMessage(message: string): string {
  return message.trim();
}

function semanticAttributeValue(
  value: string | number | boolean | null | undefined,
): string | undefined {
  return value == null ? undefined : String(value);
}

function clampOffset(offset: number, length: number): number {
  if (!Number.isFinite(offset)) return 0;
  return Math.min(length, Math.max(0, Math.trunc(offset)));
}
