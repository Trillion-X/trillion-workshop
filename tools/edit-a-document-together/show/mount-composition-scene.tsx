import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '../../ui';
import { useBitfieldData } from '#workspace-records';
import { sendCompositionTransaction } from '../do-work/send-composition-transaction';
import { hydrateCompositionScene } from '../do-work/hydrate-composition-scene';
import {
  materializeCompositionBoundFeeds,
  readCompositionContent,
  type CompositionSnapshot,
} from '../read-data/documents';
import { CompositionSurfaceContent } from './CompositionSurfaceContent';
import {
  parseCompositionSceneInput,
  readAccessRefs,
  type CompositionSceneInput,
} from '../read-data/composition-scene-input';

type MountArgs = { el: HTMLElement; props?: Record<string, unknown> };

const sceneStageStyle: React.CSSProperties = {
  height: 'clamp(32rem, calc(100vh - 14rem), 72rem)',
  minHeight: '32rem',
  width: '100%',
  overflow: 'hidden',
};

function ReadOnlyScene({ snapshot, authoredEdges }: { snapshot: CompositionSnapshot; authoredEdges: readonly { edge_id: string; label?: string }[] }) {
  return (
    <CompositionSurfaceContent
      snapshot={snapshot}
      framedNodeId={snapshot.tree?.id ?? null}
      hideWorkspaceChrome
      canEdit={false}
      authoredEdges={authoredEdges}
      onSelect={() => undefined}
      onTextChange={() => undefined}
      onAutoformat={() => null}
      matchShortcut={() => null}
      dispatchShortcut={() => false}
      openComposer={() => false}
      getCursorCommands={() => []}
      getInlineMarks={() => []}
      onTextFocus={() => undefined}
      onEscape={() => undefined}
      onInsertBeside={() => undefined}
      onMergeBackward={() => false}
      onCreateComponent={() => undefined}
      onAddBlockBelow={() => undefined}
      editorPlaceholder=""
      onMeasureTextHeight={() => undefined}
      revealTextNodeIds={new Set()}
      streamingTextNodeId={null}
      streamingText=""
      onRemoveBlock={() => undefined}
      onBeginDrag={() => undefined}
      dragNodeId={null}
      onStartConnect={() => undefined}
      onNoteAction={() => undefined}
      noteActions={[]}
      onResizeFrame={() => undefined}
      onSplitDragStart={() => undefined}
      onSplitDrag={() => undefined}
      onEditVisibility={() => undefined}
      onEditSpacing={() => undefined}
      onFloatNode={() => undefined}
      onCollapsePanel={() => undefined}
      onExpandPanel={() => undefined}
      onInsertTableRow={() => undefined}
      onRemoveTableRow={() => undefined}
      onInsertTableColumn={() => undefined}
      onRemoveTableColumn={() => undefined}
    />
  );
}

function CompositionScene({ input }: { input: CompositionSceneInput }) {
  const selectedDocument = useBitfieldData({
    input: 'selector-source-by-address-label',
    params: { addressLabel: input.scene_address },
  });
  const selectedBoundRows = useBitfieldData({
    input: 'selector-source-by-address-label',
    params: { addressLabel: input.bound_feed_address_label ?? null },
  });
  const viewerAccess = useBitfieldData('viewer-access-refs');
  const [snapshot, setSnapshot] = React.useState<CompositionSnapshot | null>(null);
  const [authoredEdges, setAuthoredEdges] = React.useState<readonly { edge_id: string; label?: string }[]>([]);
  const [state, setState] = React.useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const stageRef = React.useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = React.useState({ w: 960, h: 720 });
  const instanceId = React.useId();
  const session = `${input.scene_address}::rendered::${instanceId}`;
  const accessRefs = React.useMemo(() => readAccessRefs(viewerAccess), [viewerAccess]);
  const canView = !input.required_view_access_ref || accessRefs.has(input.required_view_access_ref);
  const content = React.useMemo(() => {
    const authored = readCompositionContent(selectedDocument);
    const boundRows = input.bound_feed_address_label && Array.isArray(selectedBoundRows)
      ? selectedBoundRows
      : [];
    return authored
      // A browser clock is an INPUT the log records, so a surface reads its own;
      // only a derivation replayed against the log takes it from the runtime.
      ? materializeCompositionBoundFeeds(authored, boundRows, input.scene_address, Date.now()) ?? authored
      : null;
  }, [input.bound_feed_address_label, input.scene_address, selectedBoundRows, selectedDocument]);

  React.useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const w = Math.max(1, Math.round(entry?.contentRect.width ?? el.clientWidth));
      const h = Math.max(1, Math.round(entry?.contentRect.height ?? el.clientHeight));
      setViewport((current) => current.w === w && current.h === h ? current : { w, h });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    if (!canView) { setSnapshot(null); setAuthoredEdges([]); setState('error'); return; }
    if (!content) { setSnapshot(null); setAuthoredEdges([]); setState('empty'); return; }
    setState('loading');
    void hydrateCompositionScene({
      content,
      session,
      viewport,
      sendTransaction: sendCompositionTransaction,
    }).then((result) => {
      if (cancelled) return;
      setSnapshot(result.snapshot);
      setAuthoredEdges(result.authoredEdges);
      setState(result.snapshot.tree ? 'ready' : 'empty');
      console.info(`[composition-scene] rendered nodes=${Object.keys(result.snapshot.frames).length} editable=false`);
    }).catch((error) => {
      if (cancelled) return;
      setSnapshot(null);
      setAuthoredEdges([]);
      setState('error');
      console.error(`[composition-scene] load failed scene=${input.scene_address} reason=engine-hydration`, error);
    });
    return () => { cancelled = true; };
  }, [canView, content, input.scene_address, session, viewport]);

  return (
    <div ref={stageRef} style={sceneStageStyle} data-composition-scene={input.scene_address}>
      {snapshot ? <ReadOnlyScene snapshot={snapshot} authoredEdges={authoredEdges} /> : (
        <div className="grid h-full min-h-48 place-items-center p-8 text-center text-sm text-[var(--text-secondary)]" data-composition-scene-state={state}>
          {state === 'loading' ? input.loading_label : state === 'empty' ? input.empty_label : input.error_label}
        </div>
      )}
    </div>
  );
}

function CompositionSceneMaterial({ props }: { props: Record<string, unknown> }) {
  const nested = props.surfaceInput && typeof props.surfaceInput === 'object' && !Array.isArray(props.surfaceInput)
    ? props.surfaceInput
    : props;
  const input = parseCompositionSceneInput(nested);
  const frame = input?.floating_frame ?? (props.floating_frame as Record<string, unknown> | undefined);
  return (
    <FloatingMaterialFrame frame={frame} className="h-full min-h-0 overflow-hidden">
      <ErrorBoundary zoneName="composition scene material">
        {input ? <CompositionScene input={input} /> : (
          <div className="grid h-full min-h-48 place-items-center p-8 text-center text-sm text-[var(--text-secondary)]">
            This view could not load.
          </div>
        )}
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <CompositionSceneMaterial props={props} />);
}
