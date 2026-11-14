/**
 * file: packages/content-production/show/ContentLibraryPanel.tsx
 *
 * PURPOSE: The Library surface (plan §13A U02) — every pickable media source
 * (files, recordings, prior production outputs) in one searchable Fey-style
 * table. Reference anatomy: amie-audio-file-browser-list-view-duration (rows
 * carry kind, duration, and date; one tap previews) + Fey golden rules (one
 * accent, quiet rows, hairline separation). Row actions: Play (inline
 * AudioClipPlayer) and "Make content" (places the Make-content surface with
 * the source pre-selected via the generic placeable-surface intent).
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. Zero imports from slot::workflow or slot::eeaf — reads only via useBitfieldData
 * 2. Components only from @/packages/ui; zero inline style objects
 * 3. Source truth is the contentMediaEvidence feed — component state holds only
 *    search text and the currently-previewed item id/url
 * 4. Source packages come from run-profile DATA (read-content-library) — never enumerated here
 * 5. Playback resolves bytes via the generic self-describing chunk-ref reader
 *    in @/packages/ui — zero producer-package imports (L090)
 * 6. Observability: logs `[ui:content-library] mounted input=<n> records` on mount
 */

import * as React from 'react';

import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { Pause, Play, Search, Sparkles } from 'lucide-react';

import {
  AudioClipPlayer,
  Button,
  Container,
  EvidenceSourceCard,
  Icon,
  Input,
  ResponsiveSwitch,
  ScrollableSurface,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Text,
  emitPlaceableSurfaceIntent,
  isSelfDescribingChunkRef,
  readSelfDescribingChunkBlob,
} from '@/packages/ui';

import {
  durationLabel,
  filterContentLibraryItems,
  friendlyDate,
  readContentLibraryItems,
  readContentLibraryOutputs,
  sourcePackageLabel,
  type ContentLibraryItem,
} from '@/packages/content-production/read-data/read-content-library';

/**
 * Place the Make-content surface with this source pre-selected. The intent
 * payload is opaque to this panel; the arrangement decides placement, and the
 * Make-content surface reads the same evidence feed to resolve the id.
 */
function makeContentFrom(item: ContentLibraryItem): boolean {
  return emitPlaceableSurfaceIntent({
    id: 'content-production.panel',
    title: 'Make content',
    target: null,
    packageEntry: { packageName: 'content-production', entryName: 'content-production' },
    materialTarget: 'content-production',
    surfaceInput: {
      source_id: item.id,
      source_package: item.sourcePackage,
      source_ref: item.sourceRef,
    },
  });
}

/** The playable ref inside a library item, when its bytes live in this browser. */
function playableRef(item: ContentLibraryItem) {
  const stored = item.raw['stored_file_ref'] ?? (item.sourceRef as Record<string, unknown>)['stored_file_ref'];
  return isSelfDescribingChunkRef(stored) ? stored : null;
}

type PreviewState =
  | { kind: 'idle' }
  | { kind: 'loading'; itemId: string }
  | { kind: 'playing'; itemId: string; url: string }
  | { kind: 'unavailable'; itemId: string };

export function ContentLibraryPanel() {
  const evidenceRows = useBitfieldData('content-production:contentMediaEvidence');
  const [search, setSearch] = React.useState('');
  const [preview, setPreview] = React.useState<PreviewState>({ kind: 'idle' });

  const items = React.useMemo(() => readContentLibraryItems(evidenceRows), [evidenceRows]);
  const outputs = React.useMemo(() => readContentLibraryOutputs(evidenceRows), [evidenceRows]);
  const visibleItems = React.useMemo(() => filterContentLibraryItems(items, search), [items, search]);

  React.useEffect(() => {
    console.log(`[ui:content-library] mounted input=${items.length} records`);
  }, [items.length]);

  // Object URLs are released when preview moves on or the panel unmounts.
  React.useEffect(() => () => {
    if (preview.kind === 'playing') URL.revokeObjectURL(preview.url);
  }, [preview]);

  async function togglePreview(item: ContentLibraryItem) {
    if (preview.kind === 'playing' && preview.itemId === item.id) {
      URL.revokeObjectURL(preview.url);
      setPreview({ kind: 'idle' });
      return;
    }
    if (preview.kind === 'playing') URL.revokeObjectURL(preview.url);
    const ref = playableRef(item);
    if (!ref) {
      setPreview({ kind: 'unavailable', itemId: item.id });
      return;
    }
    setPreview({ kind: 'loading', itemId: item.id });
    const blob = await readSelfDescribingChunkBlob(ref);
    if (!blob) {
      setPreview({ kind: 'unavailable', itemId: item.id });
      return;
    }
    setPreview({ kind: 'playing', itemId: item.id, url: URL.createObjectURL(blob) });
  }

  function previewCellFor(item: ContentLibraryItem): React.ReactNode {
    const isThisItem = preview.kind !== 'idle' && preview.itemId === item.id;
    if (isThisItem && preview.kind === 'unavailable') {
      return <Text variant="body-xs" color="secondary">Not on this device</Text>;
    }
    if (!playableRef(item)) return null;
    return (
      <Button
        variant="ghost"
        size="sm"
        aria-label={isThisItem && preview.kind === 'playing' ? `Stop ${item.label}` : `Play ${item.label}`}
        loading={isThisItem && preview.kind === 'loading'}
        onClick={() => { void togglePreview(item); }}
      >
        <Icon icon={isThisItem && preview.kind === 'playing' ? Pause : Play} size="sm" />
      </Button>
    );
  }

  return (
    <ScrollableSurface>
      <Container layout="vertical" gap="lg" padding="lg" height="full">
        <Container layout="horizontal" gap="md" alignItems="center">
          <Container layout="vertical" gap="xs" flex={1}>
            <Text variant="heading-lg">Library</Text>
            <Text variant="label">Files, recordings, and finished outputs — press play to check one, then make content from it.</Text>
          </Container>
          <Container layout="vertical" gap="none" maxWidth="sm" width="full">
            <Input
              aria-label="Search the library"
              placeholder="Search"
              icon={<Icon icon={Search} size="sm" color="muted" />}
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
            />
          </Container>
        </Container>

        {preview.kind === 'playing' ? (
          <AudioClipPlayer src={preview.url} autoPlay onEnded={() => setPreview({ kind: 'idle' })} />
        ) : null}

        {visibleItems.length === 0 ? (
          <Container layout="vertical" gap="xs" padding="xl" alignItems="center">
            <Text variant="body" color="secondary">
              {search ? 'Nothing in the library matches that search.' : 'Nothing in the library yet.'}
            </Text>
            <Text variant="label">
              {search ? 'Try a shorter search.' : 'Record or add a file and it appears here.'}
            </Text>
          </Container>
        ) : (
          <ResponsiveSwitch
            wide={(
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead aria-label="Preview" />
                    <TableHead>Name</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Length</TableHead>
                    <TableHead>Added</TableHead>
                    <TableHead>From</TableHead>
                    <TableHead aria-label="Row actions" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleItems.map((item) => (
                    <TableRow key={`${item.sourcePackage}:${item.id}`} interactive>
                      <TableCell>{previewCellFor(item)}</TableCell>
                      <TableCell>
                        <Text variant="body" truncate>{item.label}</Text>
                      </TableCell>
                      <TableCell>
                        <Text variant="body-xs" color="secondary">{item.kindLabel}</Text>
                      </TableCell>
                      <TableCell>
                        <Text variant="body-xs" color="secondary">{durationLabel(item.durationMs) ?? '—'}</Text>
                      </TableCell>
                      <TableCell>
                        <Text variant="body-xs" color="secondary">{item.recordedAt ? friendlyDate(item.recordedAt) : '—'}</Text>
                      </TableCell>
                      <TableCell>
                        <Text variant="body-xs" color="secondary">{sourcePackageLabel(item.sourcePackage)}</Text>
                      </TableCell>
                      <TableCell>
                        <Button variant="ghost" size="sm" onClick={() => makeContentFrom(item)}>
                          <Icon icon={Sparkles} size="sm" />
                          Make content
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            narrow={(
              <Container layout="vertical" gap="sm">
                {visibleItems.map((item) => (
                  <EvidenceSourceCard
                    key={`m:${item.sourcePackage}:${item.id}`}
                    id={item.id}
                    label={item.label}
                    originLabel={[item.kindLabel, durationLabel(item.durationMs), sourcePackageLabel(item.sourcePackage)].filter(Boolean).join(' · ')}
                    actionLabel="Make content"
                    onAction={() => makeContentFrom(item)}
                    density="card"
                  />
                ))}
              </Container>
            )}
          />
        )}

        {outputs.length > 0 ? (
          <Container layout="vertical" gap="sm">
            <Text variant="heading">Finished outputs</Text>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Output</TableHead>
                  <TableHead>Completed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {outputs.map((output) => (
                  <TableRow key={output.id}>
                    <TableCell>
                      <Text variant="body" truncate>{output.label}</Text>
                    </TableCell>
                    <TableCell>
                      <Text variant="body-xs" color="secondary">{friendlyDate(output.completedAt)}</Text>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Container>
        ) : null}
      </Container>
    </ScrollableSurface>
  );
}
