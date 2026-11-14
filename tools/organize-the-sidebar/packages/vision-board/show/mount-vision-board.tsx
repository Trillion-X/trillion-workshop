// packages/vision-board/show/mount-vision-board.tsx
//
// Vision Board PRODUCT composition root. Composes the GENERIC group board with:
//   - the image-generation producer (single artifact, DATA descriptor)
//   - the link-card auto-enrichment producer (DATA descriptor)
//   - the board's ACTION TOOLS, read as `action-affordance` published records —
//     the R10/P7 primitive. The old VISION_TOOL/BREAKDOWN_TOOL TS constants are
//     DELETED: an action exists iff a record exists (add/author one → it appears,
//     zero source change, zero redeploy).
//
// The agent behind prompt actions is resolved engine-side by
// `action:run-ai-records-production` reading the `selected-agent` SSOT; the
// board only forwards opaque input.

import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface, Container } from '@/packages/ui';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { bitfieldGeneratedLiveReadScopeDescriptor } from '@/packages/vision-board/.bitfield-entry-scope/vision-board/runtime-kit-react';
import { readPublishedRecords } from '@/packages/ui/show/placeable-surface-intent';
import { readActionAffordances } from '@/packages/ui/show/action-affordance';
import { GroupBoardPanel } from '@/packages/group/show/GroupBoardPanel';
import { affordanceShelfTools } from '@/packages/group/show/board-action-affordances';
import type { ProducerSubmitDescriptor } from '@/packages/group/do-work/submit-producer-request';
import { VISION_BOARD_BYTES_NAMESPACE } from '@/packages/vision-board/do-work/vision-board-bytes-namespace';
import { ActivityIndicator } from '@/packages/activity-feed/show/ActivityIndicator';

type MountArgs = { el: HTMLElement; props?: Record<string, unknown> };

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

// The board is a full-pane surface: it must FILL its mount with a definite height
// so the canvas can flex-grow to the bottom (no magic-number height, no gap below).
// Respect an explicit fixed/floating placement (popout with coordinates); otherwise
// upgrade the frame to `fill` (height:100%) — the definite-height parent the board's
// h-full root needs. `inline` (min-height:100%) is NOT definite, so it leaves the gap.
function fillFrame(input: unknown): Record<string, unknown> {
  const frame = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const placed = frame.mode === 'fixed' || typeof frame.top_px === 'number' || typeof frame.left_px === 'number';
  return placed ? frame : { ...frame, mode: 'fill' };
}

// The "Generate" image producer (DATA). Absent image provider → honest error.
// (An AUTO behavior backing the generic produce strategy — not a user action row,
// so it stays a mount descriptor rather than an affordance record.)
const VISION_BOARD_PRODUCER: ProducerSubmitDescriptor = {
  definitionId: 'action:submit-image-generation-request',
  resultAddressTemplate: 'package::image-generation::result::{id}',
  errorAddressTemplate: 'package::image-generation::error::{id}',
  // image-generation writes its result with address_mode:identity_text into
  // "runtime-partition"; without these the board polls its own (bitfield-studio)
  // partition in the wrong mode and shows "Working…" forever. (same fix as breakdown)
  addressMode: 'identity-text',
  resultPartitionLabel: 'runtime-partition',
  baseInput: { requested_at: '', options: {} },
};

// The link-card AUTO-enrichment producer (DATA). Fires on paste of a URL: the generic
// `link-preview` package's leaf def fetches the page (slot::http-client) and extracts
// its OpenGraph preview (compute.process), writing an identity-preserving result the
// board's #208 poller merges onto the pasted card in place — bare-domain title flips to
// the real page title + og:image. The def is self-contained (parser baked in), so the
// board passes only { href, member_id, result_address }. Writes label-hash into
// runtime-partition (same polling contract as the breakdown producer). Absent provider
// concerns: a public fetch needs no credential; nothing extractable → card keeps its
// domain (no fake, L117).
const LINK_ENRICH_PRODUCER: ProducerSubmitDescriptor = {
  definitionId: 'action:enrich-link-preview',
  resultAddressTemplate: 'package::link-preview::result::{id}',
  errorAddressTemplate: 'package::link-preview::error::{id}',
  addressMode: 'label-hash',
  resultPartitionLabel: 'runtime-partition',
};

function VisionBoardMaterial({ props }: { props: Record<string, unknown> }) {
  // This fallback used to be the literal 'bitfield-studio'. Studio is RETIRED, and this
  // package is installed in four sets, three of which are not Studio, so a mount that
  // omitted the prop addressed a dead app's partition. No mount DATA here passes
  // `partition_label` (the `result_partition_label` rows are a different field), so that
  // was the live path, not a defensive one.
  //
  // The generated descriptor is the right source: the generator stamps it with the
  // partition of the set this surface was BUILT into, so the board names the app it
  // actually runs in. Same owner already adopted by crm, record-audio, and
  // visual-database. `readTrustedRuntimePartition` is not usable here, because the
  // runner hands a partition to targets only, never to a browser surface.
  const partitionLabel = asString(
    props.partition_label ?? props.partitionLabel,
    bitfieldGeneratedLiveReadScopeDescriptor.partitionLabel,
  );
  const boardId = asString(props.board_id ?? props.boardId, 'vision-board');

  // Action tools from records (R10/P7): decode every published action-affordance
  // row and hand the board whatever exists. Deleting the records empties the
  // list (honest); authoring one live makes it appear — no source, no redeploy.
  // The 'published-records' input is repointed (in things.json) to a scoped
  // action-affordance json_array feed — the board (this mount AND the bundled
  // GroupBoardPanel) only reads published-records for action-affordance tools.
  // So opening the board no longer blocks the engine re-materializing 34.7MB
  // (which was stalling every other tab-open behind it in the one engine queue).
  // readPublishedRecords decodes the {record,payload} feed shape natively.
  const publishedRecordsRaw = useBitfieldData('published-records');
  const activity = useBitfieldData('scoped-recent-activity');
  const actionTools = React.useMemo(() => {
    const rows = readActionAffordances(readPublishedRecords(publishedRecordsRaw));
    const tools = affordanceShelfTools(rows, { surface: { board_id: boardId } });
    if (tools.length > 0) console.log(`[action-affordance] vision-board shelf tools from records: ${tools.map((t) => t.label).join(', ')}`);
    return tools;
  }, [publishedRecordsRaw, boardId]);

  return (
    <FloatingMaterialFrame frame={fillFrame(props.floating_frame)}>
      <ErrorBoundary zoneName="vision-board material">
        <Container layout="vertical" height="full" minHeight="0" data-reach-role="section-list">
          <Container layout="vertical" height="full" minHeight="0" data-reach-role="item-gallery">
            <GroupBoardPanel
              partitionLabel={partitionLabel}
              boardId={boardId}
              title="Vision Board"
              subtitle="Everything you are building toward, in one place. Add it. Group it. Make it real."
              producer={VISION_BOARD_PRODUCER}
              linkEnrichProducer={LINK_ENRICH_PRODUCER}
              extraTools={actionTools}
              bytesNamespace={VISION_BOARD_BYTES_NAMESPACE}
              cadence={{ unit: 'day' }}
            />
            {/* L069 Live Actor Activity Indicator: Shows live writes from ANY actor (AI, human, batch, external) */}
            <ActivityIndicator
              activity={Array.isArray(activity) ? activity : undefined}
              packageId="vision-board"
              maxVisible={3}
              position="top-right"
            />
          </Container>
        </Container>
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <VisionBoardMaterial props={props} />);
}
