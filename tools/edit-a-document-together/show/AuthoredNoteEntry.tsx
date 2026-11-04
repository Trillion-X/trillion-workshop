import * as React from 'react';
import { Container, ErrorBoundary, FloatingMaterialFrame, mountReactSurface, Spinner, Text } from '../../ui';
import { useBitfieldData } from '#workspace-records';
import { bitfieldGeneratedLiveReadScopeDescriptor } from '#workspace-records';
import {
  readCompositionRuntimeConfig,
  type CompositionContent,
} from '../read-data/documents';
import { findSubtree } from '../read-data/authored-thing-refs';
import { projectSceneSubtreeToSections } from '../do-work/project-scene-to-file-request';
import { createCompositionDocumentsLogStore } from '../do-work/write-composition-documents';
import { normalizeFeedRows } from '../read-data/feed-rows';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function rowsAt(raw: unknown, address: string): unknown[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((row) => {
    if (typeof row !== 'object' || row === null) return false;
    return (row as Record<string, unknown>).address === address;
  });
}

type NoteInput = { nodeId: string; title: string };

function stringProp(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

// The host forwards a placeable surface's `surface_input` as `props.surfaceInput`.
// A board-placed note carries the block it renders (node_id) and its heading
// (title) there — everything the mount needs, no record lookup required.
function noteInputFromProps(props: Record<string, unknown>): NoteInput | null {
  const surfaceInput = props.surfaceInput;
  const carrier = (surfaceInput && typeof surfaceInput === 'object')
    ? (surfaceInput as Record<string, unknown>)
    : props;
  const nodeId = stringProp(carrier.node_id);
  if (!nodeId) return null;
  return { nodeId, title: stringProp(carrier.title) ?? 'Untitled' };
}

function AuthoredNoteView({ nodeId, title }: NoteInput) {
  // Scoped feed (record_from_matching_records DATA row), not the multi-MB
  // published-records aggregate — this mount only needs the package's own
  // runtime-config row. Rows arrive as {record:{address},payload}; normalize
  // to the {address,payload} contract rowsAt expects.
  const ownedRows = useBitfieldData('ca-owned-feed');
  // A published runtime-config record wins. If the generated descriptor has no
  // partition, wait for that record before reading a note.
  const runtimeConfig = React.useMemo(
    () => readCompositionRuntimeConfig(
      rowsAt(normalizeFeedRows(ownedRows), 'package::documents::runtime-config'),
      bitfieldGeneratedLiveReadScopeDescriptor.partitionLabel,
    ),
    [ownedRows],
  );
  const [content, setContent] = React.useState<CompositionContent | null>(null);
  const [state, setState] = React.useState<'loading' | 'ready' | 'error'>('loading');

  React.useEffect(() => {
    if (!runtimeConfig) return;
    let cancelled = false;
    // A surface clock is an INPUT the log records, not a derivation reaching for
    // one; this entry only reads, so the store never calls it.
    const store = createCompositionDocumentsLogStore(runtimeConfig.partition_label, () => Date.now());
    store.read()
      .then((stored) => {
        if (cancelled) return;
        setContent(stored);
        setState('ready');
        console.log(`[documents] mounted note ${nodeId}`);
      })
      .catch(() => {
        if (cancelled) return;
        setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [runtimeConfig, nodeId]);

  if (!runtimeConfig || state === 'loading') {
    return (
      <Container layout="vertical" alignItems="center" justifyContent="center" padding="lg" gap="md">
        <Spinner />
        <Text variant="body-xs" color="faint">Loading note...</Text>
      </Container>
    );
  }
  if (state === 'error') {
    return (
      <Container layout="vertical" padding="lg">
        <Text variant="body" color="muted">This note could not load right now.</Text>
      </Container>
    );
  }
  const subtree = content ? findSubtree(content, nodeId) : null;
  if (!subtree) {
    return (
      <Container layout="vertical" padding="lg">
        <Text variant="body" color="muted">This note is no longer in the current pages.</Text>
      </Container>
    );
  }
  const sections = projectSceneSubtreeToSections(subtree);
  return (
    <Container layout="vertical" padding="lg" gap="md">
      <Text variant="heading-sm">{title}</Text>
      {sections.map((section, sectionIndex) => (
        <Container key={sectionIndex} layout="vertical" gap="sm">
          {section.heading ? <Text variant="heading-xs">{section.heading}</Text> : null}
          {(section.lines ?? []).map((line, lineIndex) => (
            <Text key={lineIndex} variant="body">{line}</Text>
          ))}
          {(section.rows ?? []).map((row, rowIndex) => (
            <Container key={rowIndex} layout="horizontal" gap="md">
              {row.map((cell, cellIndex) => (
                <Text key={cellIndex} variant={rowIndex === 0 ? 'label' : 'body'} color={rowIndex === 0 ? 'muted' : undefined}>
                  {cell}
                </Text>
              ))}
            </Container>
          ))}
        </Container>
      ))}
    </Container>
  );
}

function AuthoredNoteMaterial({ props }: { props: Record<string, unknown> }) {
  const note = noteInputFromProps(props);
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="authored note material">
        {note ? (
          <AuthoredNoteView nodeId={note.nodeId} title={note.title} />
        ) : (
          <Container layout="vertical" padding="lg">
            <Text variant="body" color="muted">No note was chosen for this spot.</Text>
          </Container>
        )}
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <AuthoredNoteMaterial props={props} />);
}
