import React from 'react';
import {
  Button,
  Container,
  Dropdown,
  ExpressionComposer,
  Input,
  Text,
  type ExpressionCommitAcceptance,
  type ExpressionCommitRequest,
  type ExpressionCompletionItem,
  type ExpressionComposerState,
  type ExpressionDiagnosticItem,
  type ExpressionPostCommitMoveIntent,
  type ExpressionReferenceItem,
} from '../../ui';
import type {
  VisualDatabaseCellRef,
  VisualDatabaseDependencyRef,
  VisualDatabaseEvaluatorDescriptor,
  VisualDatabaseValueExpression,
} from 'trillion-workshop/tools/keep-lists-of-rows/read-data/visual-database.ts';
import type { DeriveDispatch } from 'trillion-workshop/tools/keep-lists-of-rows/do-work/resolve-derived-fields.ts';
import type { CellSourceMutationResult } from 'trillion-workshop/tools/keep-lists-of-rows/do-work/cell-source-mutation.ts';
import { cellRefKey } from 'trillion-workshop/tools/keep-lists-of-rows/do-work/cell-expression.ts';
import {
  buildDurableExpressionOwnerRequest,
  expressionEvaluationProvenanceLabels,
  readDurableExpressionSource,
} from 'trillion-workshop/tools/keep-lists-of-rows/do-work/expression-owner-protocol.ts';
import { restoreControlledTextSelection } from '../../ui/show/input/useControlledTextSelection';
import {
  ExpressionOwnerSessionFactory,
  ExpressionOwnerStaleReplyError,
} from 'trillion-workshop/tools/keep-lists-of-rows/do-work/expression-owner-session.ts';
import {
  formatExpressionReferenceSelection,
  indexExpressionReferences,
  mapExpressionEvaluationReads,
  type ExpressionReferenceCandidate,
  type ExpressionReferenceCatalog,
  type MappedExpressionEvaluationReads,
} from 'trillion-workshop/tools/keep-lists-of-rows/show/reference-catalog.ts';

export interface ExpressionReferenceSelection {
  id: string;
  candidates: readonly ExpressionReferenceCandidate[];
  gesture: 'single' | 'range' | 'multiple' | 'replace';
}

export interface CellEvaluationProjection {
  value: unknown;
  evaluatorRef: string;
  evaluatorTarget: string;
  evaluatorRevision: string;
  registryRevision: string;
  policyRevision: string;
  provenanceRefFamily: string;
  provenanceDisplayLabel: string;
  reads: MappedExpressionEvaluationReads;
}

export interface CellExpressionEditorProps {
  cellRef: VisualDatabaseCellRef;
  cellLabel?: string;
  expression: VisualDatabaseValueExpression;
  evaluators: readonly VisualDatabaseEvaluatorDescriptor[];
  revision?: string;
  error?: string;
  resolutionErrorCode?: 'cycle' | 'missing-dependency' | 'evaluator';
  dependencyPath?: readonly { key: string; label: string }[];
  entryTrigger?: string;
  sourceTestId?: string;
  controlledDraft?: {
    source: string;
    selection: readonly [number, number];
  };
  onDraftChange?: (draft: {
    source: string;
    selection: readonly [number, number];
  }) => void;
  referenceCatalog?: ExpressionReferenceCatalog;
  externalReferenceSelection?: ExpressionReferenceSelection | null;
  dispatch?: DeriveDispatch;
  ownerSessionFactory?: ExpressionOwnerSessionFactory;
  readOnly?: boolean;
  cachedValue?: unknown;
  provenanceDisplayLabel?: string;
  projectionState?: 'current' | 'stale' | 'missing' | 'partial';
  onRevealReference?: (ref: { recordRef: string; fieldRef: string }) => void;
  onReferencePickingChange?: (active: boolean) => void;
  onCommit: (next: {
    cellRef: VisualDatabaseCellRef;
    expression: VisualDatabaseValueExpression;
    expectedRevision?: string;
    evaluationProjection?: CellEvaluationProjection;
  }) => void | CellSourceMutationResult | Promise<void | CellSourceMutationResult>;
  onMoveAfterCommit?: (
    intent: Exclude<ExpressionPostCommitMoveIntent, 'none'>,
    acceptance: ExpressionCommitAcceptance,
  ) => void;
  onDismiss: () => void;
}

interface OwnerProjection {
  completions: readonly ExpressionCompletionItem[];
  dependencies: readonly DependencyProjection[];
  diagnostics: readonly CellExpressionDiagnosticItem[];
  result?: unknown;
  readset?: unknown;
  mappedReads?: CellEvaluationProjection['reads'];
}

interface DependencyProjection {
  id: string;
  name: string;
  span?: { startUtf16: number; endUtf16: number };
  candidate?: ExpressionReferenceCandidate;
}

interface CellExpressionDiagnosticItem extends ExpressionDiagnosticItem {
  code: string;
}

interface FunctionProjection {
  id: string;
  category?: string;
  signature?: string;
  summary?: string;
}

interface PickTransaction {
  id: string;
  source: string;
  selection: readonly [number, number];
  gesture: ExpressionReferenceSelection['gesture'];
  referenceIds: readonly string[];
}

interface LegacySourceProjection {
  state: 'checking' | 'available' | 'needs_conversion' | 'unavailable' | 'accepted';
  expression?: string;
  explanation?: string;
}

interface SaveFailureProjection {
  kind: Extract<CellSourceMutationResult['state'], 'conflict' | 'failed' | 'unknown'> | 'offline';
  draftSource: string;
  draftSelection: readonly [number, number];
  result?: CellSourceMutationResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function sourceSpan(value: unknown): { startUtf16: number; endUtf16: number } | null {
  if (!isRecord(value)) return null;
  const start = value.start_utf16 ?? value.startUtf16;
  const end = value.end_utf16 ?? value.endUtf16;
  return Number.isInteger(start) && Number.isInteger(end) && (start as number) >= 0 && (end as number) >= (start as number)
    ? { startUtf16: start as number, endUtf16: end as number }
    : null;
}

function functionItems(value: unknown): readonly FunctionProjection[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const id = nonEmptyString(entry.id);
    if (!id) return [];
    return [{
      id,
      ...(nonEmptyString(entry.category) ? { category: nonEmptyString(entry.category)! } : {}),
      ...(nonEmptyString(entry.signature) ? { signature: nonEmptyString(entry.signature)! } : {}),
      ...(nonEmptyString(entry.summary) ? { summary: nonEmptyString(entry.summary)! } : {}),
    }];
  });
}

function completionItems(
  value: unknown,
  functions: readonly FunctionProjection[],
): readonly ExpressionCompletionItem[] {
  if (!isRecord(value) || !Array.isArray(value.items)) return [];
  const activeArgument = value.active_argument ?? value.activeArgument;
  return value.items.flatMap((entry, index) => {
    if (!isRecord(entry)) return [];
    const id = nonEmptyString(entry.id) ?? `completion-${index}`;
    const metadata = functions.find((item) => item.id === id);
    const label = nonEmptyString(entry.label);
    const insertionText = nonEmptyString(entry.insertion_text ?? entry.insertionText);
    const replacementSpan = sourceSpan(entry.replacement_span ?? entry.replacementSpan);
    const caret = entry.post_insert_caret_utf16 ?? entry.postInsertCaretUtf16;
    return label && insertionText && replacementSpan && Number.isInteger(caret)
      ? [{
          id,
          label,
          ...(nonEmptyString(entry.detail) ? { detail: nonEmptyString(entry.detail)! } : {}),
          ...(nonEmptyString(entry.group) ? { group: nonEmptyString(entry.group)! } : {}),
          ...(nonEmptyString(entry.kind) ? { kind: nonEmptyString(entry.kind)! } : {}),
          ...(nonEmptyString(entry.category)
            ? { category: nonEmptyString(entry.category)! }
            : metadata?.category ? { category: metadata.category } : {}),
          ...(nonEmptyString(entry.signature)
            ? { signature: nonEmptyString(entry.signature)! }
            : metadata?.signature ? { signature: metadata.signature } : {}),
          ...(Number.isInteger(activeArgument) ? { currentArgument: activeArgument as number } : {}),
          ...(nonEmptyString(entry.summary)
            ? { summary: nonEmptyString(entry.summary)! }
            : metadata?.summary ? { summary: metadata.summary } : {}),
          insertionText,
          replacementSpan,
          postInsertCaretUtf16: caret as number,
        }]
      : [];
  });
}

function diagnosticItems(
  value: unknown,
  labels: Readonly<Record<string, string>>,
): readonly CellExpressionDiagnosticItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    if (!isRecord(entry)) return [];
    const span = sourceSpan(entry.span);
    const code = nonEmptyString(entry.code) ?? `diagnostic-${index}`;
    const rawSeverity = nonEmptyString(entry.severity);
    const severity = rawSeverity === 'error' || rawSeverity === 'warning' || rawSeverity === 'info' || rawSeverity === 'incomplete'
      ? rawSeverity
      : 'error';
    return span
      ? [{
          id: `${code}-${index}`,
          code,
          severity,
          title: labels[code] ?? nonEmptyString(entry.title) ?? labels[severity] ?? 'Expression needs a change',
          ...(nonEmptyString(entry.cause) ? { cause: nonEmptyString(entry.cause)! } : {}),
          ...(nonEmptyString(entry.repair) ? { repair: nonEmptyString(entry.repair)! } : {}),
          span,
        }]
      : [];
  });
}

function dependencyItems(
  value: unknown,
  catalog?: ExpressionReferenceCatalog,
): readonly DependencyProjection[] {
  if (!Array.isArray(value)) return [];
  const index = catalog ? indexExpressionReferences(catalog.candidates) : new Map();
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const name = nonEmptyString(entry.name);
    if (!name) return [];
    const matches = index.get(name) ?? [];
    const candidate = matches.length === 1 ? matches[0] : undefined;
    return [{
      id: candidate?.id ?? `unresolved::${encodeURIComponent(name)}`,
      name,
      ...(sourceSpan(entry.span) ? { span: sourceSpan(entry.span)! } : {}),
      ...(candidate ? { candidate } : {}),
    }];
  });
}

function unknownReferenceDiagnostics(
  dependencies: readonly DependencyProjection[],
): readonly CellExpressionDiagnosticItem[] {
  return dependencies.flatMap((dependency, index) => dependency.candidate ? [] : [{
    id: `reference-${dependency.name}-${index}`,
    code: 'unknown-reference',
    severity: 'error' as const,
    title: 'Pick the intended value',
    cause: `${dependency.name} does not identify one available value.`,
    repair: 'Choose a value from the board.',
    action: {
      id: 'pick-reference',
      label: 'Pick a value',
    },
    span: dependency.span ?? { startUtf16: 0, endUtf16: 0 },
  }]);
}

function valuesFromCatalog(catalog?: ExpressionReferenceCatalog): Readonly<Record<string, unknown>> {
  return Object.fromEntries((catalog?.candidates ?? []).map((candidate) => [candidate.bindingKey, candidate.value]));
}

function mapEvaluationReads(
  value: unknown,
  catalog?: ExpressionReferenceCatalog,
): { reads: CellEvaluationProjection['reads']; diagnostics: readonly CellExpressionDiagnosticItem[] } {
  const mapped = mapExpressionEvaluationReads(value, catalog);
  return {
    reads: mapped.reads,
    diagnostics: mapped.issues.map((issue) => ({
      id: `read-${issue.bindingKey ?? 'malformed'}-${issue.rowIndex}`,
      code: issue.code,
      severity: 'error',
      title: issue.code === 'malformed-read' ? 'The evaluator returned an invalid reference' : 'Pick the intended value',
      cause: issue.code === 'ambiguous-root'
        ? `${issue.bindingKey} identifies more than one available value.`
        : issue.code === 'missing-root'
          ? `${issue.bindingKey} does not identify an available value.`
          : 'A returned reference is missing its binding identity.',
      repair: issue.code === 'malformed-read' ? 'Check the evaluator and try again.' : 'Choose a value from the board.',
      ...(issue.code === 'malformed-read'
        ? {}
        : {
            action: {
              id: 'pick-reference',
              label: 'Pick a value',
            },
          }),
      span: issue.span ?? { startUtf16: 0, endUtf16: 0 },
    })),
  };
}

function initialAuthoringEvaluator(
  expression: VisualDatabaseValueExpression,
  evaluators: readonly VisualDatabaseEvaluatorDescriptor[],
  entryTrigger?: string,
): VisualDatabaseEvaluatorDescriptor | undefined {
  const current = expression.derive
    ? evaluators.find((candidate) => candidate.ref === expression.derive?.evaluatorRef)
    : undefined;
  if (current?.authoring) return current;
  if (!entryTrigger) return undefined;
  return evaluators.find((candidate) => candidate.authoring?.entryActions.some((action) => (
    action.trigger === entryTrigger || action.id === entryTrigger
  )));
}

function insertionWithBoundary(
  source: string,
  selection: readonly [number, number],
  insertion: string,
  separator: string,
): string {
  const start = Math.max(0, Math.min(source.length, Math.min(selection[0], selection[1])));
  const end = Math.max(start, Math.min(source.length, Math.max(selection[0], selection[1])));
  const before = source.slice(0, start);
  const after = source.slice(end);
  const prefix = before.length > 0 && !before.endsWith(separator) && !/[=(,+\-*/^<>&]$/.test(before)
    ? separator
    : '';
  const suffix = after.length > 0 && !after.startsWith(separator) && !/^[),+\-*/^<>&]/.test(after)
    ? separator
    : '';
  return `${prefix}${insertion}${suffix}`;
}

function mutationState(
  result: void | CellSourceMutationResult,
): ExpressionComposerState {
  if (!result) return 'editing';
  if (result.state === 'saved') return 'saved';
  if (result.state === 'conflict') return 'conflict';
  return 'invalid';
}

function invalidLifecycleAnnouncement(
  authoring: NonNullable<VisualDatabaseEvaluatorDescriptor['authoring']>,
  diagnostics: readonly CellExpressionDiagnosticItem[],
): string {
  const ownerLabel = authoring.diagnosticLabels.invalid ?? 'Expression needs a change';
  const repair = diagnostics.find((diagnostic) => (
    diagnostic.severity === 'error' && diagnostic.repair?.trim()
  ))?.repair?.trim();
  if (!repair) return ownerLabel;
  const normalizedRepair = repair.replace(/[.!?]+$/u, '');
  return /\ba change\b/iu.test(ownerLabel)
    ? ownerLabel.replace(/\ba change\b/iu, normalizedRepair)
    : `${ownerLabel}: ${normalizedRepair}`;
}

function resultLifecycleAnnouncement(
  authoring: NonNullable<VisualDatabaseEvaluatorDescriptor['authoring']>,
  value: unknown,
): string {
  return `${authoring.explanationSections[2] ?? 'Result'} ${String(value ?? '')}`;
}

function addressedReadbackSource(
  authoring: NonNullable<VisualDatabaseEvaluatorDescriptor['authoring']>,
  result?: CellSourceMutationResult,
): string | null {
  if (!result) return null;
  const payload = result.current?.payload;
  if (!isRecord(payload) || !isRecord(payload.expression) || !isRecord(payload.expression.derive)) {
    return null;
  }
  return readDurableExpressionSource(authoring, payload.expression.derive.request);
}

/** The editor is blind to expression syntax and owner field names. Authoring
 * descriptors select the shared composer and define every request/reply path;
 * evaluators without that contract retain an explicit advanced JSON editor. */
export function CellExpressionEditor(props: CellExpressionEditorProps) {
  const initialAuthoring = initialAuthoringEvaluator(props.expression, props.evaluators, props.entryTrigger);
  const initialDerive = props.expression.derive;
  const [mode, setMode] = React.useState<'literal' | 'derive'>(
    initialAuthoring || initialDerive ? 'derive' : 'literal',
  );
  const [literal, setLiteral] = React.useState(props.expression.literal === undefined ? '' : String(props.expression.literal));
  const [evaluatorRef, setEvaluatorRef] = React.useState(
    initialAuthoring?.ref ?? initialDerive?.evaluatorRef ?? props.evaluators[0]?.ref ?? '',
  );
  const selected = props.evaluators.find((candidate) => candidate.ref === evaluatorRef);
  const authoring = selected?.authoring;
  const initialSource = authoring
    ? readDurableExpressionSource(authoring, initialDerive?.request) ?? authoring.sourcePrefix
    : '';
  const [uncontrolledDraft, setUncontrolledDraft] = React.useState(() => ({
    source: initialSource,
    selection: [initialSource.length, initialSource.length] as const,
  }));
  const draft = props.controlledDraft ?? uncontrolledDraft;
  const source = draft.source;
  const selection = draft.selection;
  const draftRef = React.useRef(draft);
  draftRef.current = draft;
  const sourceInstanceId = `visual-database-formula-${encodeURIComponent(props.cellRef.recordRef)}-${encodeURIComponent(props.cellRef.fieldRef)}`;
  const sourceControlId = `${sourceInstanceId}-source`;
  const [requestText, setRequestText] = React.useState(
    JSON.stringify(initialDerive?.request ?? selected?.request ?? {}),
  );
  const [requestError, setRequestError] = React.useState<string | null>(null);
  const [dependencies, setDependencies] = React.useState(initialDerive?.dependencyRefs ?? []);
  const [projection, setProjection] = React.useState<OwnerProjection>({
    completions: [],
    dependencies: [],
    diagnostics: [],
  });
  const [functions, setFunctions] = React.useState<readonly FunctionProjection[]>([]);
  const [state, setState] = React.useState<ExpressionComposerState>(authoring ? 'analyzing' : 'editing');
  const [announcement, setAnnouncement] = React.useState('');
  const [saveFailure, setSaveFailure] = React.useState<SaveFailureProjection | null>(null);
  const [referencePicking, setReferencePicking] = React.useState(false);
  const [pickHistory, setPickHistory] = React.useState<readonly PickTransaction[]>([]);
  const pickHistoryRef = React.useRef<readonly PickTransaction[]>([]);
  const [ownerReady, setOwnerReady] = React.useState(false);
  const [capabilityAttempt, setCapabilityAttempt] = React.useState(0);
  const durableInitialSource = authoring
    ? readDurableExpressionSource(authoring, initialDerive?.request)
    : null;
  const [legacyProjection, setLegacyProjection] = React.useState<LegacySourceProjection | null>(
    authoring && initialDerive && !durableInitialSource
      ? { state: 'checking' }
      : null,
  );
  const sourceRevision = React.useRef(`draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  const lifecycle = React.useRef(0);
  const lastExternalPick = React.useRef<string | null>(null);
  const conversionCommitPending = React.useRef(false);
  const pickTransactionSequence = React.useRef(0);
  const pendingSourceFocus = React.useRef<{
    source: string;
    selection: readonly [number, number];
  } | null>(null);
  const [sourceFocusRequest, setSourceFocusRequest] = React.useState(0);
  const updateDraft = React.useCallback((
    nextSource: string,
    nextSelection: readonly [number, number],
  ) => {
    draftRef.current = { source: nextSource, selection: nextSelection };
    if (!props.controlledDraft) {
      setUncontrolledDraft({ source: nextSource, selection: nextSelection });
    }
    props.onDraftChange?.({ source: nextSource, selection: nextSelection });
  }, [props.controlledDraft, props.onDraftChange]);
  const restoreAuthoritativeSourceFocus = React.useCallback((
    nextSource: string,
    nextSelection: readonly [number, number],
  ) => {
    pendingSourceFocus.current = {
      source: nextSource,
      selection: nextSelection,
    };
    setSourceFocusRequest((request) => request + 1);
  }, []);

  React.useLayoutEffect(() => {
    const pending = pendingSourceFocus.current;
    if (!pending
      || pending.source !== source
      || pending.selection[0] !== selection[0]
      || pending.selection[1] !== selection[1]) return;
    const control = document.getElementById(sourceControlId);
    if (!(control instanceof HTMLTextAreaElement)) return;
    restoreControlledTextSelection(control, pending.source, pending.selection, true);
    pendingSourceFocus.current = null;
  }, [selection, source, sourceControlId, sourceFocusRequest]);

  const localOwnerSessionFactory = React.useMemo(
    () => props.dispatch ? new ExpressionOwnerSessionFactory(props.dispatch) : null,
    [props.dispatch],
  );
  const ownerSessionFactory = props.ownerSessionFactory ?? localOwnerSessionFactory;
  const ownerSession = React.useMemo(() => (
    selected && authoring && ownerSessionFactory
      ? ownerSessionFactory.create({
          target: selected.target,
          descriptor: authoring,
          sourceRevision: sourceRevision.current,
          catalogRevision: props.referenceCatalog?.revision ?? 'catalog-empty',
        })
      : null
  ), [
    authoring,
    ownerSessionFactory,
    props.referenceCatalog?.revision,
    selected?.target,
  ]);

  React.useEffect(() => () => ownerSession?.close(), [ownerSession]);

  const dispatchOwner = React.useCallback(async (
    operation: 'analyze' | 'evaluate' | 'project_source',
    values: Record<string, unknown>,
  ) => {
    if (!ownerSession) return null;
    try {
      const reply = operation === 'analyze'
        ? await ownerSession.analyze(values)
        : operation === 'evaluate'
          ? await ownerSession.evaluate(values)
          : await ownerSession.projectSource(values);
      return reply.values;
    } catch (error) {
      if (error instanceof ExpressionOwnerStaleReplyError) return null;
      throw error;
    }
  }, [ownerSession]);

  React.useEffect(() => {
    lifecycle.current += 1;
    setOwnerReady(false);
    setFunctions([]);
    setProjection({ completions: [], dependencies: [], diagnostics: [] });
    if (!authoring || !ownerSession) {
      setState('editing');
      return undefined;
    }
    let cancelled = false;
    setState('analyzing');
    setAnnouncement(authoring.stateLabels.analyzing ?? 'Checking expression');
    void ownerSession.capabilities(capabilityAttempt > 0).then((capabilities) => {
      if (cancelled) return;
      setFunctions(functionItems(capabilities.functions));
      setOwnerReady(true);
      setState('editing');
    }).catch(() => {
      if (cancelled) return;
      setProjection((current) => ({
        ...current,
        diagnostics: [{
          id: 'capabilities',
          code: 'capabilities-unavailable',
          severity: 'error',
          title: 'Expression tools are unavailable',
          cause: 'The formula tools did not reply.',
          repair: 'Try again.',
          span: { startUtf16: 0, endUtf16: source.length },
        }],
      }));
      setState('invalid');
      setAnnouncement(invalidLifecycleAnnouncement(authoring, [{
        id: 'capabilities',
        code: 'capabilities-unavailable',
        severity: 'error',
        title: 'Expression tools are unavailable',
        cause: 'The formula tools did not reply.',
        repair: 'Try again.',
        span: { startUtf16: 0, endUtf16: source.length },
      }]));
    });
    return () => {
      cancelled = true;
      ownerSession.cancelPending();
    };
  // The owner target/descriptor/catalog identity are the capability boundary.
  // Source changes do not refresh capabilities.
  }, [authoring, capabilityAttempt, ownerSession]);

  React.useEffect(() => {
    if (!authoring
      || !ownerSession
      || !ownerReady
      || !initialDerive
      || legacyProjection?.state !== 'checking') return undefined;
    let cancelled = false;
    void dispatchOwner('project_source', {
      legacy_request: initialDerive.request ?? {},
    }).then((values) => {
      if (cancelled || !values) return;
      const rawProjection = values.legacy_projection;
      if (!isRecord(rawProjection)) {
        setLegacyProjection({ state: 'unavailable' });
        return;
      }
      const rawState = nonEmptyString(rawProjection.state);
      const state = rawState === 'available'
        || rawState === 'needs_conversion'
        || rawState === 'unavailable'
        ? rawState
        : 'unavailable';
      const nextProjection: LegacySourceProjection = {
        state,
        ...(nonEmptyString(rawProjection.expression)
          ? { expression: nonEmptyString(rawProjection.expression)! }
          : {}),
        ...(nonEmptyString(rawProjection.explanation)
          ? { explanation: nonEmptyString(rawProjection.explanation)! }
          : {}),
      };
      setLegacyProjection(nextProjection);
      if (state === 'available' && nextProjection.expression) {
        updateDraft(nextProjection.expression, [
          nextProjection.expression.length,
          nextProjection.expression.length,
        ]);
      }
    }).catch(() => {
      if (!cancelled) setLegacyProjection({ state: 'unavailable' });
    });
    return () => { cancelled = true; };
  }, [
    authoring,
    dispatchOwner,
    initialDerive,
    legacyProjection?.state,
    ownerReady,
    ownerSession,
    updateDraft,
  ]);

  React.useEffect(() => {
    if (!authoring
      || !ownerSession
      || !ownerReady
      || legacyProjection?.state === 'checking'
      || legacyProjection?.state === 'needs_conversion'
      || legacyProjection?.state === 'unavailable') return undefined;
    const generation = ++lifecycle.current;
    setState('analyzing');
    setAnnouncement(authoring.stateLabels.analyzing ?? 'Checking expression');
    const timer = window.setTimeout(() => {
      void dispatchOwner('analyze', {
        source,
        cursor_offset_utf16: selection[1],
        variables: valuesFromCatalog(props.referenceCatalog),
      }).then(async (values) => {
        if (!values || generation !== lifecycle.current) return;
        const mappedDependencies = dependencyItems(values.static_dependencies, props.referenceCatalog);
        const ownerDiagnostics = diagnosticItems(values.diagnostics, authoring.diagnosticLabels);
        const diagnostics = [...ownerDiagnostics, ...unknownReferenceDiagnostics(mappedDependencies)];
        setProjection((current) => ({
          ...current,
          completions: completionItems(values.completion, functions),
          dependencies: mappedDependencies,
          diagnostics,
        }));
        if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
          setState('invalid');
          setAnnouncement(invalidLifecycleAnnouncement(authoring, diagnostics));
          return;
        }
        setState('previewing');
        const evaluated = await dispatchOwner('evaluate', {
          source,
          cursor_offset_utf16: selection[1],
          variables: valuesFromCatalog(props.referenceCatalog),
        });
        if (!evaluated || generation !== lifecycle.current) return;
        const evaluateDependencies = dependencyItems(evaluated.static_dependencies, props.referenceCatalog);
        const mappedReadset = mapEvaluationReads(evaluated.evaluation_readset, props.referenceCatalog);
        const evaluateDiagnostics = [
          ...diagnosticItems(evaluated.diagnostics, authoring.diagnosticLabels),
          ...unknownReferenceDiagnostics(evaluateDependencies),
          ...mappedReadset.diagnostics,
        ];
        setProjection({
          completions: completionItems(values.completion, functions),
          dependencies: evaluateDependencies,
          diagnostics: evaluateDiagnostics,
          result: evaluated.evaluation_result,
          readset: evaluated.evaluation_readset,
          mappedReads: mappedReadset.reads,
        });
        const hasEvaluationError = evaluateDiagnostics.some((diagnostic) => diagnostic.severity === 'error');
        setState(hasEvaluationError ? 'invalid' : 'valid');
        setAnnouncement(hasEvaluationError
          ? invalidLifecycleAnnouncement(authoring, evaluateDiagnostics)
          : resultLifecycleAnnouncement(authoring, evaluated.evaluation_result));
      }).catch((error) => {
        if (error instanceof ExpressionOwnerStaleReplyError) return;
        if (generation !== lifecycle.current) return;
        setProjection((current) => ({
          ...current,
          diagnostics: [{
            id: 'owner-error',
            code: 'owner-unavailable',
            severity: 'error',
            title: 'Expression tools could not check this source',
            cause: 'The formula tools did not reply.',
            repair: 'Try again.',
            span: { startUtf16: 0, endUtf16: source.length },
          }],
        }));
        setState('invalid');
        setAnnouncement(invalidLifecycleAnnouncement(authoring, [{
          id: 'owner-error',
          code: 'owner-unavailable',
          severity: 'error',
          title: 'Expression tools could not check this source',
          cause: 'The formula tools did not reply.',
          repair: 'Try again.',
          span: { startUtf16: 0, endUtf16: source.length },
        }]));
      });
    }, authoring.interactionPolicy.idleMs);
    return () => {
      window.clearTimeout(timer);
      ownerSession.cancelPending();
    };
  }, [
    authoring,
    dispatchOwner,
    props.referenceCatalog,
    ownerReady,
    ownerSession,
    selection,
    source,
    legacyProjection?.state,
    functions,
  ]);

  React.useEffect(() => {
    if (!authoring || props.projectionState !== 'stale') return;
    setAnnouncement(authoring.stateLabels.stale ?? 'Result is stale');
  }, [authoring, props.projectionState]);

  const applyPickedCandidates = React.useCallback((
    candidates: readonly ExpressionReferenceCandidate[],
    gesture: ExpressionReferenceSelection['gesture'],
    suppliedTransactionId?: string,
  ) => {
    if (!authoring || candidates.length === 0) return;
    const uniqueCandidates = candidates.filter((candidate, index) => (
      candidates.findIndex((entry) => entry.id === candidate.id) === index
    ));
    const effectiveGesture = selection[0] !== selection[1] ? 'replace' : gesture;
    const insertion = formatExpressionReferenceSelection(uniqueCandidates, authoring.selectionPolicy);
    const boundedInsertion = effectiveGesture === 'replace'
      ? insertion
      : insertionWithBoundary(source, selection, insertion, authoring.selectionPolicy.separator);
    pickTransactionSequence.current += 1;
    const transactionId = suppliedTransactionId?.trim()
      || `${cellRefKey(props.cellRef)}::pick::${pickTransactionSequence.current}`;
    const transaction: PickTransaction = {
      id: transactionId,
      source,
      selection,
      gesture: effectiveGesture,
      referenceIds: uniqueCandidates.map((candidate) => candidate.id),
    };
    pickHistoryRef.current = [...pickHistoryRef.current, transaction];
    setPickHistory(pickHistoryRef.current);
    const start = Math.min(selection[0], selection[1]);
    const end = Math.max(selection[0], selection[1]);
    const nextSource = `${source.slice(0, start)}${boundedInsertion}${source.slice(end)}`;
    const caret = start + boundedInsertion.length;
    const nextSelection = [caret, caret] as const;
    updateDraft(nextSource, nextSelection);
    restoreAuthoritativeSourceFocus(nextSource, nextSelection);
  }, [
    authoring,
    props.cellRef,
    restoreAuthoritativeSourceFocus,
    selection,
    source,
    updateDraft,
  ]);

  React.useEffect(() => {
    const picked = props.externalReferenceSelection;
    if (!picked || picked.id === lastExternalPick.current) return;
    lastExternalPick.current = picked.id;
    applyPickedCandidates(picked.candidates, picked.gesture, picked.id);
  }, [applyPickedCandidates, props.externalReferenceSelection]);

  React.useEffect(() => {
    props.onReferencePickingChange?.(referencePicking);
  }, [props.onReferencePickingChange, referencePicking]);

  const saveAdvanced = async () => {
    let request: Readonly<Record<string, unknown>> | undefined;
    if (mode === 'derive' && requestText.trim()) {
      try {
        const parsed = JSON.parse(requestText) as unknown;
        if (!isRecord(parsed)) {
          setRequestError('Enter one JSON object.');
          return;
        }
        request = parsed;
      } catch {
        setRequestError("That isn't valid JSON yet.");
        return;
      }
    }
    const next: VisualDatabaseValueExpression = mode === 'literal'
      ? { literal }
      : {
          derive: {
            target: selected?.target ?? evaluatorRef,
            evaluatorRef,
            ...(request ? { request } : {}),
            ...(selected?.resultPath ? { resultPath: selected.resultPath } : {}),
            ...(selected?.dependencySelector ? { dependencySelector: selected.dependencySelector } : {}),
            dependencyRefs: dependencies,
          },
        };
    await props.onCommit({
      cellRef: props.cellRef,
      expression: next,
      ...(props.revision ? { expectedRevision: props.revision } : {}),
    });
  };

  const commitAuthoredExpression = async ({
    committedSource,
    committedSelection,
    expression,
    evaluationProjection,
    closeOnSaved,
  }: {
    committedSource: string;
    committedSelection: readonly [number, number];
    expression: VisualDatabaseValueExpression;
    evaluationProjection?: CellEvaluationProjection;
    closeOnSaved: boolean;
  }): Promise<ExpressionCommitAcceptance> => {
    if (!authoring) return { accepted: false };
    setState('saving');
    setAnnouncement(authoring.stateLabels.saving ?? 'Saving');
    try {
      const result = await props.onCommit({
        cellRef: props.cellRef,
        expression,
        ...(props.revision ? { expectedRevision: props.revision } : {}),
        ...(evaluationProjection ? { evaluationProjection } : {}),
      });
      const nextState = mutationState(result);
      const acceptance: ExpressionCommitAcceptance = result && result.state === 'saved'
        ? {
            accepted: true,
            readbackIdentity: result.readbackIdentity,
          }
        : { accepted: false };
      setState(nextState);
      if (acceptance.accepted) {
        setSaveFailure(null);
        setAnnouncement(authoring.stateLabels.saved ?? 'Saved');
        if (closeOnSaved) props.onDismiss();
        return acceptance;
      } else if (nextState === 'conflict') {
        if (result) setSaveFailure({
          kind: 'conflict',
          draftSource: committedSource,
          draftSelection: committedSelection,
          result,
        });
        setAnnouncement('Save conflict; draft kept');
      } else {
        if (result && (result.state === 'failed' || result.state === 'unknown')) {
          const failureKind = result.state === 'failed'
            && (result.writeError !== undefined || result.readError !== undefined)
            ? 'offline'
            : result.state;
          setSaveFailure({
            kind: failureKind,
            draftSource: committedSource,
            draftSelection: committedSelection,
            result,
          });
        }
        const offline = !!result && result.state === 'failed'
          && (result.writeError !== undefined || result.readError !== undefined);
        setAnnouncement(offline
          ? authoring.stateLabels.offline ?? 'Offline; draft kept'
          : 'The source was not saved; draft kept');
      }
    } catch {
      setState('invalid');
      setSaveFailure({
        kind: 'offline',
        draftSource: committedSource,
        draftSelection: committedSelection,
      });
      setAnnouncement(authoring.stateLabels.offline ?? 'Offline; draft kept');
      setProjection((current) => ({
        ...current,
        diagnostics: [{
          id: 'save-failed',
          severity: 'error',
          title: 'Could not save this expression',
          cause: 'The save did not complete.',
          repair: 'Try again.',
          span: { startUtf16: 0, endUtf16: committedSource.length },
        }],
      }));
    }
    return { accepted: false };
  };

  const saveAuthored = async (
    commitRequest?: ExpressionCommitRequest,
  ): Promise<ExpressionCommitAcceptance> => {
    if (!selected
      || !authoring
      || projection.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      return { accepted: false };
    }
    const dependencyRefs = projection.dependencies.flatMap((dependency): readonly VisualDatabaseDependencyRef[] => (
      dependency.candidate
        ? [{
            recordRef: dependency.candidate.recordRef,
            fieldRef: dependency.candidate.fieldRef,
            contextKey: dependency.candidate.bindingKey,
          }]
        : []
    ));
    const expression: VisualDatabaseValueExpression = {
      derive: {
        target: selected.target,
        evaluatorRef: selected.ref,
        request: buildDurableExpressionOwnerRequest(
          authoring,
          source,
          props.expression.derive?.request ?? selected.request,
        ),
        ...(selected.resultPath ? { resultPath: selected.resultPath } : {}),
        ...(selected.dependencySelector ? { dependencySelector: selected.dependencySelector } : {}),
        dependencyRefs,
      },
    };
    const provenanceLabels = expressionEvaluationProvenanceLabels(selected);
    const ownerRevisions = ownerSession?.revisions();
    return commitAuthoredExpression({
      committedSource: source,
      committedSelection: selection,
      expression,
      closeOnSaved: (commitRequest?.moveIntent ?? 'none') === 'none',
      ...(projection.result !== undefined
        && projection.mappedReads
        && ownerRevisions
        ? {
            evaluationProjection: {
              value: projection.result,
              evaluatorRef: selected.ref,
              evaluatorTarget: selected.target,
              evaluatorRevision: selected.revision ?? authoring.revision,
              registryRevision: ownerRevisions.registryRevision,
              policyRevision: ownerRevisions.policyRevision,
              provenanceRefFamily: provenanceLabels.family,
              provenanceDisplayLabel: provenanceLabels.displayLabel,
              reads: projection.mappedReads,
            },
          }
        : {}),
    });
  };

  const switchSource = (value: string) => {
    ownerSession?.cancelPending();
    if (value === 'literal') {
      lifecycle.current += 1;
      setMode('literal');
      setReferencePicking(false);
      return;
    }
    const evaluator = props.evaluators.find((candidate) => candidate.ref === value);
    lifecycle.current += 1;
    setMode('derive');
    setEvaluatorRef(value);
    setRequestText(JSON.stringify(evaluator?.request ?? {}));
    setRequestError(null);
    if (evaluator?.authoring) {
      const durable = evaluator.ref === props.expression.derive?.evaluatorRef
        ? readDurableExpressionSource(evaluator.authoring, props.expression.derive.request)
        : null;
      const nextSource = durable ?? evaluator.authoring.sourcePrefix;
      updateDraft(nextSource, [nextSource.length, nextSource.length]);
    }
  };

  const sourcePicker = (
    <Dropdown
      aria-label="Cell value source"
      disabled={props.readOnly}
      items={[
        { value: 'literal', label: 'Typed value' },
        ...props.evaluators.map((item) => ({ value: item.ref, label: item.label ?? item.ref })),
      ]}
      value={mode === 'literal' ? 'literal' : evaluatorRef}
      onValueChange={switchSource}
    />
  );

  const acceptLegacyConversion = async () => {
    if (conversionCommitPending.current || !selected || !authoring) return;
    const projected = legacyProjection?.expression;
    if (!projected) return;
    conversionCommitPending.current = true;
    const prior = props.expression.derive;
    const resultPath = prior?.resultPath ?? selected.resultPath;
    const dependencySelector = prior?.dependencySelector ?? selected.dependencySelector;
    const expression: VisualDatabaseValueExpression = {
      derive: {
        target: prior?.target ?? selected.target,
        evaluatorRef: prior?.evaluatorRef ?? selected.ref,
        request: buildDurableExpressionOwnerRequest(
          authoring,
          projected,
          prior?.request ?? selected.request,
        ),
        ...(resultPath ? { resultPath } : {}),
        ...(dependencySelector ? { dependencySelector } : {}),
        dependencyRefs: prior?.dependencyRefs ?? [],
      },
    };
    try {
      const acceptance = await commitAuthoredExpression({
        committedSource: projected,
        committedSelection: [projected.length, projected.length],
        expression,
        closeOnSaved: false,
      });
      if (acceptance.accepted) {
        updateDraft(projected, [projected.length, projected.length]);
        setLegacyProjection({ ...legacyProjection, state: 'accepted' });
      }
    } finally {
      conversionCommitPending.current = false;
    }
  };

  if (mode === 'derive' && authoring) {
    const humanCellLabel = props.cellLabel ?? props.cellRef.fieldRef;
    const composerState: ExpressionComposerState = props.readOnly
      ? 'read-only'
      : props.projectionState === 'stale'
        && (state === 'editing' || state === 'previewing' || state === 'valid')
        ? 'stale'
        : state;
    const referenceItems: readonly ExpressionReferenceItem[] = (props.referenceCatalog?.candidates ?? []).map((candidate) => ({
      id: candidate.id,
      label: candidate.displayAlias,
      detail: candidate.valueType,
      insertionText: candidate.insertionText,
    }));
    const resolutionDiagnostic: CellExpressionDiagnosticItem | null = props.resolutionErrorCode
      ? {
          id: `visual-database-${props.resolutionErrorCode}`,
          code: props.resolutionErrorCode,
          severity: 'error',
          title: props.resolutionErrorCode === 'cycle'
            ? 'This formula depends on itself'
            : props.resolutionErrorCode === 'missing-dependency'
              ? 'A referenced value is missing'
              : 'This formula could not be computed',
          cause: props.resolutionErrorCode === 'cycle'
            ? 'The dependency path returns to a value already being evaluated.'
            : props.resolutionErrorCode === 'missing-dependency'
              ? 'One cell in the saved dependency path is no longer available.'
              : 'The evaluator could not produce a result.',
          repair: props.resolutionErrorCode === 'missing-dependency'
            ? 'Pick an available value to replace the missing reference.'
            : 'Open Explain to inspect the complete dependency path.',
          ...(props.resolutionErrorCode === 'missing-dependency' ? {
            action: { id: 'pick-reference', label: 'Pick a value' },
          } : {}),
          span: { startUtf16: 0, endUtf16: source.length },
        }
      : null;
    const composerDiagnostics: readonly CellExpressionDiagnosticItem[] = resolutionDiagnostic
      ? [resolutionDiagnostic, ...projection.diagnostics]
      : projection.diagnostics;
    const uses = projection.dependencies.map((dependency, index) => (
      <Button
        key={`${dependency.id}:${dependency.span?.startUtf16 ?? index}:${dependency.span?.endUtf16 ?? index}`}
        variant="ghost"
        size="sm"
        targetRole="reference"
        data-testid={dependency.candidate ? `formula-use-${dependency.candidate.displayAlias}` : undefined}
        data-reference-id={dependency.id}
        data-uses-reference-id={dependency.id}
        data-reference-binding-key={dependency.candidate?.bindingKey ?? dependency.name}
        onClick={() => {
          if (!props.readOnly && dependency.span) {
            updateDraft(source, [dependency.span.startUtf16, dependency.span.endUtf16]);
          }
          if (dependency.candidate) {
            props.onRevealReference?.({
              recordRef: dependency.candidate.recordRef,
              fieldRef: dependency.candidate.fieldRef,
            });
          }
          if (!props.readOnly) setReferencePicking(true);
        }}
      >
        {dependency.candidate?.displayAlias ?? dependency.name}
      </Button>
    ));
    const topPickTransaction = pickHistory[pickHistory.length - 1];
    const selectedReferenceCandidates = topPickTransaction?.referenceIds.flatMap((id) => {
      const candidate = props.referenceCatalog?.candidates.find((entry) => entry.id === id);
      return candidate ? [candidate] : [];
    }) ?? [];
    const usesRegion = (
      <Container
        role="region"
        aria-label="Values used by this formula"
        data-testid="formula-uses"
        data-cell-key={cellRefKey(props.cellRef)}
        data-reference-ids={projection.dependencies.map((dependency) => dependency.id).join(' ')}
        layout="horizontal"
        gap="xs"
        padding="none"
        wrap="wrap"
      >
        <Text variant="caption" color="muted">Uses</Text>
        {uses.length > 0 ? uses : <Text variant="body-xs" color="muted">No referenced values</Text>}
      </Container>
    );
    if (legacyProjection?.state === 'checking') {
      return (
        <Container
          role="group"
          aria-label="Checking existing formula"
          data-testid="formula-legacy-checking"
          data-ui-node="expression-editor"
          data-cell-key={cellRefKey(props.cellRef)}
          layout="vertical"
          gap="sm"
          padding="md"
        >
          <Text role="status" data-testid="formula-checking-status" variant="body-sm">
            Checking existing formula
          </Text>
          <Text role="note" variant="body-sm" color="muted">
            The original structured formula stays unchanged while its owner prepares a human source.
          </Text>
          <Button variant="ghost" size="sm" onClick={props.onDismiss}>Close</Button>
        </Container>
      );
    }
    if (legacyProjection?.state === 'needs_conversion') {
      return (
        <Container
          role="dialog"
          aria-label="Convert structured formula"
          data-testid="formula-conversion-overlay"
          data-ui-node="formula-conversion-overlay"
          data-overlay-owner-id="selected-cell"
          layout="vertical"
          gap="sm"
          padding="md"
        >
          <Text role="note" data-testid="structured-source-summary" variant="body-sm" color="muted">
            The original structured formula is preserved until you accept this human formula.
          </Text>
          <Input
            role="textbox"
            aria-label={`Projected formula for ${humanCellLabel}`}
            data-testid="projected-human-formula"
            value={legacyProjection.expression ?? ''}
            readOnly
          />
          <Text role="note" data-testid="formula-preview" variant="body-sm">
            {legacyProjection.explanation ?? 'A human formula preview is ready.'}
          </Text>
          <Container layout="horizontal" gap="xs" padding="none">
            <Button
              variant="primary"
              size="sm"
              data-testid="use-human-formula"
              disabled={state === 'saving'}
              onClick={() => acceptLegacyConversion()}
            >
              Use human formula
            </Button>
            <Button variant="ghost" size="sm" data-testid="formula-cancel" onClick={props.onDismiss}>Cancel</Button>
          </Container>
        </Container>
      );
    }
    if (legacyProjection?.state === 'unavailable') {
      return (
        <Container
          role="group"
          aria-label="Structured formula"
          data-ui-node="expression-editor"
          data-cell-key={cellRefKey(props.cellRef)}
          layout="vertical"
          gap="sm"
          padding="md"
        >
          <Text role="note" data-testid="structured-source-summary" variant="body-sm" color="muted">
            The original structured formula is preserved and remains read-only.
          </Text>
          <Text role="status" data-testid="projection-unavailable" variant="body-sm">
            {legacyProjection.explanation ?? 'This formula cannot be converted automatically.'}
          </Text>
          {!props.readOnly ? (
            <Button
              variant="primary"
              size="sm"
              data-testid="start-human-formula"
              onClick={() => {
                updateDraft(authoring.sourcePrefix, [authoring.sourcePrefix.length, authoring.sourcePrefix.length]);
                setLegacyProjection({ state: 'accepted' });
              }}
            >
              Start human formula
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={props.onDismiss}>Close</Button>
        </Container>
      );
    }
    return (
      <Container
        role="dialog"
        aria-label="Edit cell value"
        layout="vertical"
        gap="sm"
        padding="md"
        data-ui-node="expression-editor"
        data-expression-editor-owner={props.readOnly ? undefined : 'true'}
        data-cell-key={cellRefKey(props.cellRef)}
        data-formula-result={projection.result === undefined ? '' : String(projection.result)}
        data-expression-lifecycle-state={saveFailure?.kind ?? composerState}
        data-undo-transaction-count={pickHistory.length}
        data-undo-transaction-id={topPickTransaction?.id ?? ''}
        data-undo-transaction-gesture={topPickTransaction?.gesture ?? ''}
      >
        {sourcePicker}
        {legacyProjection?.state === 'available' ? (
          <Container layout="vertical" gap="xs" padding="none">
            <Text role="note" data-testid="structured-source-summary" variant="caption" color="muted">
              This human formula was recovered from the original structured formula.
            </Text>
            <Input
              role="textbox"
              aria-label={`Projected formula for ${humanCellLabel}`}
              data-testid="projected-human-formula"
              value={legacyProjection.expression ?? source}
              readOnly
            />
            <Text role="note" data-testid="formula-preview" variant="caption">
              {legacyProjection.explanation ?? 'Human formula recovered.'}
            </Text>
          </Container>
        ) : null}
        {topPickTransaction ? (
          <Container
            role="region"
            aria-label="Selected formula references"
            data-testid="formula-reference-selection"
            data-undo-transaction-id={topPickTransaction.id}
            data-undo-transaction-count={pickHistory.length}
            data-undo-transaction-gesture={topPickTransaction.gesture}
            layout="horizontal"
            gap="xs"
            padding="none"
            wrap="wrap"
          >
            <Text variant="caption" color="muted">Selected</Text>
            {selectedReferenceCandidates.map((candidate) => (
              <Text
                key={candidate.id}
                data-reference-id={candidate.id}
                data-reference-selected="true"
                variant="body-xs"
              >
                ✓ {candidate.displayAlias}
              </Text>
            ))}
          </Container>
        ) : null}
        <ExpressionComposer
          source={source}
          sourcePrefix=""
          selection={selection}
          state={composerState}
          instanceId={sourceInstanceId}
          cellIdentity={cellRefKey(props.cellRef)}
          sourceTestId={props.sourceTestId ?? 'formula-source'}
          testIds={{
            bar: 'formula-bar',
            listbox: 'formula-listbox',
            activeOption: 'formula-active-option',
            diagnostic: 'formula-diagnostic',
            diagnosticActionPrefix: 'diagnostic-action-',
            result: props.readOnly ? 'formula-result' : 'formula-preview',
            checkingStatus: 'formula-checking-status',
            explain: 'formula-explain',
            commit: 'formula-save',
            cancel: 'formula-cancel',
            referenceOverlay: 'formula-repair-overlay',
          }}
          overlayOwnerId="formula-composer"
          semanticNodeIds={{
            bar: 'formula-bar',
            details: 'formula-details',
            help: 'formula-help',
            signature: 'formula-signature',
            argument: 'formula-active-argument',
            activeHelp: 'formula-active-help',
            result: 'formula-result',
            content: 'formula-content',
            checking: 'formula-checking',
          }}
          humanCellLabel={humanCellLabel}
          accessibleLabel={`Formula for ${humanCellLabel}`}
          description={`Start with ${authoring.sourcePrefix}. Use F2 to edit and choose board values without typing addresses.`}
          completionItems={projection.completions}
          referenceItems={referenceItems}
          diagnostics={composerDiagnostics}
          preview={props.readOnly ? (
            <Text variant="body-sm">
              {projection.result === undefined
                ? props.cachedValue ?? 'Waiting for result'
                : String(projection.result)}
            </Text>
          ) : projection.result === undefined ? undefined : String(projection.result)}
          explanationSections={[
            {
              id: 'source',
              label: authoring.explanationSections[0] ?? 'Source',
              content: source,
            },
            {
              id: 'result',
              label: authoring.explanationSections[2] ?? 'Result',
              content: projection.result === undefined ? props.cachedValue ?? 'Waiting for preview' : String(projection.result),
            },
            ...(props.provenanceDisplayLabel ? [{
              id: 'provenance',
              label: 'Evidence',
              content: props.projectionState === 'stale' || props.projectionState === 'partial'
                ? `${props.provenanceDisplayLabel} · Result is stale`
                : props.provenanceDisplayLabel,
            }] : []),
            ...(props.dependencyPath && props.dependencyPath.length > 0 ? [{
              id: 'dependency-path',
              label: 'Dependency path',
              content: (
                <Container
                  role="list"
                  aria-label="Complete formula dependency path"
                  data-testid="formula-dependency-path"
                  layout="vertical"
                  gap="xs"
                  padding="none"
                >
                  {props.dependencyPath.map((entry, index) => (
                    <Text
                      key={`${entry.key}-${index}`}
                      role="listitem"
                      data-cell-key={entry.key}
                      data-dependency-path-index={index}
                      variant="body-xs"
                      color="muted"
                    >
                      {entry.label}
                    </Text>
                  ))}
                </Container>
              ),
            }] : []),
          ]}
          announcement={announcement}
          labels={{
            bar: `Formula bar for ${humanCellLabel}`,
            details: `Formula details for ${humanCellLabel}`,
            help: `Formula help for ${humanCellLabel}`,
            signature: 'Function signature',
            argument: 'Current argument',
            resultRegion: 'Preview',
            result: 'Result',
            checking: authoring.stateLabels.analyzing ?? 'Checking formula',
            commit: 'Save',
            cancel: 'Cancel',
            chooseReference: 'Pick values',
            stopChoosing: 'Done picking',
            retry: 'Try again',
            explain: 'Explain',
            hideExplanation: 'Hide explanation',
            references: 'Available values',
            functions: 'Functions',
            noSuggestions: 'No suggestions',
          }}
          readOnly={props.readOnly}
          referencePicking={referencePicking}
          onSourceChange={(change) => {
            updateDraft(change.source, change.selection);
          }}
          onSelectionChange={(nextSelection) => updateDraft(draftRef.current.source, nextSelection)}
          onCommit={(request) => saveAuthored(request)}
          onMoveAfterCommit={props.onMoveAfterCommit}
          onCancel={props.onDismiss}
          onRetry={() => {
            if (saveFailure) return;
            lifecycle.current += 1;
            ownerSession?.cancelPending();
            setOwnerReady(false);
            setCapabilityAttempt((attempt) => attempt + 1);
          }}
          onDiagnosticAction={(diagnostic, action) => {
            if (action.id !== 'pick-reference') return;
            updateDraft(source, [
              diagnostic.span.startUtf16,
              diagnostic.span.endUtf16,
            ]);
            setReferencePicking(true);
          }}
          onReferencePickingChange={setReferencePicking}
          onReferencePick={(item) => {
            const candidate = props.referenceCatalog?.candidates.find((entry) => entry.id === item.id);
            if (candidate) applyPickedCandidates([candidate], 'single');
          }}
          onUndo={() => {
            const previous = pickHistoryRef.current[pickHistoryRef.current.length - 1];
            if (!previous) return;
            updateDraft(previous.source, previous.selection);
            restoreAuthoritativeSourceFocus(previous.source, previous.selection);
            pickHistoryRef.current = pickHistoryRef.current.slice(0, -1);
            setPickHistory(pickHistoryRef.current);
          }}
        />
        {usesRegion}
        {composerDiagnostics.length > 0 ? (
          <div
            aria-hidden="true"
            data-testid="formula-diagnostic-evidence"
            className="sr-only"
          >
            {composerDiagnostics.map((diagnostic) => (
              <span
                key={diagnostic.id}
                data-diagnostic-code={diagnostic.code}
                data-diagnostic-start-utf16={diagnostic.span.startUtf16}
                data-diagnostic-end-utf16={diagnostic.span.endUtf16}
                data-diagnostic-action={diagnostic.action?.id ?? ''}
              />
            ))}
          </div>
        ) : null}
        {saveFailure ? (
          <Container
            data-testid="formula-save-recovery"
            data-ui-node="formula-save-recovery"
            data-save-failure-state={saveFailure.kind}
            layout="vertical"
            gap="xs"
            padding="sm"
          >
            <Input
              role="textbox"
              aria-label="Unsaved formula draft"
              data-testid="formula-draft"
              value={saveFailure.draftSource}
              readOnly
            />
            <Text
              data-testid="formula-save-state"
              variant="body-sm"
              color="danger"
            >
              {saveFailure.kind === 'offline'
                ? 'Offline'
                : saveFailure.kind === 'conflict'
                  ? 'Save conflict'
                  : saveFailure.kind === 'unknown'
                    ? 'Save not confirmed'
                    : 'Could not save'}
            </Text>
            <Text
              role="alert"
              data-testid="formula-save-error"
              variant="body-sm"
              color="danger"
            >
              {saveFailure.kind === 'conflict'
                ? 'This cell changed while you were editing. Your exact draft is still here.'
                : saveFailure.kind === 'offline'
                  ? 'You are offline. Your exact draft is still here.'
                : saveFailure.kind === 'unknown'
                  ? 'The save could not be confirmed. Your exact draft is still here.'
                  : 'The save did not complete. Your exact draft is still here.'}
            </Text>
            <Container layout="horizontal" gap="xs" padding="none" wrap="wrap">
              <Button
                variant="ghost"
                size="sm"
                data-testid="formula-reload"
                onClick={() => {
                  const acceptedSource = addressedReadbackSource(authoring, saveFailure.result)
                    ?? readDurableExpressionSource(authoring, props.expression.derive?.request);
                  if (acceptedSource !== null) {
                    updateDraft(acceptedSource, [acceptedSource.length, acceptedSource.length]);
                  }
                  setSaveFailure(null);
                  setState('editing');
                  setAnnouncement('Loaded the current saved formula');
                }}
              >
                Reload
              </Button>
              <Button
                variant="ghost"
                size="sm"
                data-testid="formula-restore-draft"
                onClick={() => {
                  updateDraft(saveFailure.draftSource, saveFailure.draftSelection);
                  restoreAuthoritativeSourceFocus(
                    saveFailure.draftSource,
                    saveFailure.draftSelection,
                  );
                  setSaveFailure(null);
                  setState('editing');
                  setAnnouncement('Draft restored');
                }}
              >
                Restore draft
              </Button>
              <Button
                variant="primary"
                size="sm"
                data-testid="formula-retry"
                onClick={() => saveAuthored()}
              >
                Retry
              </Button>
            </Container>
          </Container>
        ) : null}
      </Container>
    );
  }

  return (
    <Container role="dialog" aria-label="Edit cell value" layout="vertical" gap="sm" padding="md">
      {sourcePicker}
      {mode === 'literal' ? (
        <Input
          aria-label="Cell value"
          value={literal}
          readOnly={props.readOnly}
          onChange={(event) => setLiteral(event.currentTarget.value)}
          autoFocus
        />
      ) : (
        <Container layout="vertical" gap="xs" padding="none">
          <Text variant="caption" color="muted">Advanced owner request</Text>
          <Input
            aria-label="Evaluator request"
            placeholder="Evaluator request (JSON)"
            value={requestText}
            readOnly={props.readOnly}
            onChange={(event) => {
              setRequestText(event.currentTarget.value);
              setRequestError(null);
            }}
          />
          <Text variant="caption" color="muted">Uses these cells</Text>
          {dependencies.map((dependency, index) => (
            <Container key={`${dependency.recordRef}:${dependency.fieldRef}:${index}`} layout="horizontal" gap="xs" padding="none">
              <Input
                aria-label={`Dependency ${index + 1} record`}
                value={dependency.recordRef}
                readOnly={props.readOnly}
                onChange={(event) => {
                  const recordRef = event.currentTarget.value;
                  setDependencies((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, recordRef } : item));
                }}
              />
              <Input
                aria-label={`Dependency ${index + 1} field`}
                value={dependency.fieldRef}
                readOnly={props.readOnly}
                onChange={(event) => {
                  const fieldRef = event.currentTarget.value;
                  setDependencies((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, fieldRef } : item));
                }}
              />
              <Button
                aria-label={`Remove dependency ${index + 1}`}
                variant="ghost"
                size="sm"
                disabled={props.readOnly}
                onClick={() => setDependencies((current) => current.filter((_, itemIndex) => itemIndex !== index))}
              >
                Remove
              </Button>
            </Container>
          ))}
          <Button
            variant="ghost"
            size="sm"
            disabled={props.readOnly}
            onClick={() => setDependencies((current) => [...current, { recordRef: '', fieldRef: '' }])}
          >
            Add dependency
          </Button>
        </Container>
      )}
      {requestError || props.error ? (
        <Text role="alert" aria-live="assertive" variant="caption" color="danger">
          {requestError ?? (props.error?.toLowerCase().includes('cycle')
            ? 'Dependency cycle detected.'
            : 'The expression request could not be completed.')}
        </Text>
      ) : null}
      <Container layout="horizontal" gap="xs" padding="none">
        <Button variant="primary" size="sm" disabled={props.readOnly} onClick={() => saveAdvanced()}>Save cell</Button>
        <Button variant="ghost" size="sm" onClick={props.onDismiss}>{props.readOnly ? 'Close' : 'Cancel'}</Button>
      </Container>
    </Container>
  );
}
