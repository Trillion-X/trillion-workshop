import React from 'react';
import { Container, ErrorBoundary, FloatingMaterialFrame, Text, mountReactSurface } from '@/packages/ui';
import { ExecutionHistoryPanel } from '@/packages/ai-execution-history/show/ExecutionHistoryPanel';
import { parseHealthRules } from '@/packages/ai-execution-history/read-data/derive-run-health';
import { useBitfieldData } from '@/packages/ai-execution-history/.bitfield-entry-scope/ai-execution-history-surface/runtime-kit-react';
import { sendRequestToBitfieldTarget } from '@/packages/ai-execution-history/.bitfield-entry-scope/ai-execution-history-surface/runtime-kit';
import { VisualDatabaseSurface } from '@/packages/visual-database/show/VisualDatabaseSurface';
import {
  buildExecutionHistoryVisualDatabaseProjection,
  readExecutionHistoryVisualDatabaseFeedInputName,
} from '@/packages/ai-execution-history/read-data/execution-history-visual-database';

type MountArgs = { el: HTMLElement; props?: Record<string, unknown> };

// The owner injects the health-classification rules as DATA on the placeable
// surface (surface_input.healthRules). It reaches the mount as camelCase
// `surfaceInput` (ask-questions convention); tolerate the snake form too. The
// surface never imports a rule pack — fail-closed to no rules if none injected.
function readInjectedHealthRules(props: Record<string, unknown>): unknown {
  const camel = props.surfaceInput as { healthRules?: unknown } | undefined;
  const snake = props.surface_input as { healthRules?: unknown } | undefined;
  return camel?.healthRules ?? snake?.healthRules;
}

// A worker-console tab injects `subjectRef` (the agent this console is scoped to)
// so the history shows ONLY that agent's runs. Absent => full global history.
function readSubjectRef(props: Record<string, unknown>): string | undefined {
  const camel = props.surfaceInput as { subjectRef?: unknown; agentId?: unknown; agent_ref?: unknown } | undefined;
  const snake = props.surface_input as { subjectRef?: unknown; agentId?: unknown; agent_ref?: unknown } | undefined;
  const raw = camel?.subjectRef ?? camel?.agent_ref ?? camel?.agentId
    ?? snake?.subjectRef ?? snake?.agent_ref ?? snake?.agentId;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
}

function readSurfaceInput(props: Record<string, unknown>): unknown {
  return props.surfaceInput ?? props.surface_input;
}

const VISUAL_DATABASE_LOADING_TEXT = 'Loading execution history…';
const VISUAL_DATABASE_ERROR_TEXT = 'Unable to load execution history.';

function ExecutionHistoryVisualDatabaseMaterial({ surfaceInput }: { surfaceInput: unknown }) {
  const feedInputName = readExecutionHistoryVisualDatabaseFeedInputName(surfaceInput) ?? 'exec-history-feed';
  const feed = useBitfieldData<unknown>(feedInputName);
  const [state, setState] = React.useState<{
    error?: string;
    ready: boolean;
    projection?: Awaited<ReturnType<typeof buildExecutionHistoryVisualDatabaseProjection>>;
  }>({ ready: false });

  React.useEffect(() => {
    let cancelled = false;
    setState({ ready: false });
    buildExecutionHistoryVisualDatabaseProjection(
      surfaceInput,
      feed,
      async (target, request) => {
        const reply = await sendRequestToBitfieldTarget({ target, payload: request });
        if (!reply.payload) return null;
        return JSON.parse(new TextDecoder().decode(reply.payload));
      },
    )
      .then((projection) => {
        if (cancelled) return;
        setState({ ready: true, projection });
      })
      .catch((error) => {
        if (cancelled) return;
        setState({
          ready: true,
          error: error instanceof Error ? error.message : VISUAL_DATABASE_ERROR_TEXT,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [feed, surfaceInput]);

  if (!state.ready) {
    return (
      <Container layout="vertical" justifyContent="center" alignItems="center" padding="lg" minHeight="320px">
        <Text variant="body-sm" color="muted">{VISUAL_DATABASE_LOADING_TEXT}</Text>
      </Container>
    );
  }
  if (state.error || !state.projection) {
    return (
      <Container layout="vertical" justifyContent="center" alignItems="center" padding="lg" minHeight="320px">
        <Text variant="body-sm" color="danger">{state.error ?? VISUAL_DATABASE_ERROR_TEXT}</Text>
      </Container>
    );
  }
  return (
    <VisualDatabaseSurface
      model={state.projection.model}
      evaluatorDescriptors={state.projection.evaluatorDescriptors}
      initialViewId={state.projection.initialViewId}
    />
  );
}

function ExecutionHistoryMaterial({ props }: { props: Record<string, unknown> }) {
  const surfaceInput = readSurfaceInput(props);
  if (
    surfaceInput
    && typeof surfaceInput === 'object'
    && (surfaceInput as { surfaceKind?: unknown }).surfaceKind === 'visual-database'
  ) {
    return (
      <FloatingMaterialFrame frame={props.floating_frame}>
        <ErrorBoundary zoneName="ai-execution-history triage material">
          <ExecutionHistoryVisualDatabaseMaterial surfaceInput={surfaceInput} />
        </ErrorBoundary>
      </FloatingMaterialFrame>
    );
  }
  const healthRules = React.useMemo(() => parseHealthRules(readInjectedHealthRules(props)), [props]);
  const subjectRef = readSubjectRef(props);
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="ai-execution-history material">
        <ExecutionHistoryPanel healthRules={healthRules} subjectRef={subjectRef} />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <ExecutionHistoryMaterial props={props} />);
}
