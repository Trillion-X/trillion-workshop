// packages/media-composition/show/EditTimeline.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The reference-locked `edit-timeline` surface (W6 Unit 6). Composes the
// Descript/CapCut editing anatomy from shared primitives + package DATA:
//
//   ┌─ modality switch (DATA: edit-modality rows) ─────────────────────────┐
//   │  [ Edit by transcript ] [ Assemble from search ] [ Fix with AI ]      │
//   ├──────────────────────────────────────────────────────────────────────┤
//   │  authoring pane for the active modality                               │
//   │   • transcript  → EditTranscriptPane (words + cleanups + remove)      │
//   │   • search / ai → the modality's own flow (its offered ops named)     │
//   ├─ op action bar (DATA: edit-op rows, actionable from state) ──────────┤
//   │  [ Split ] [ Trim ] [ Delete ] …  ← add an op row ⇒ a new button      │
//   ├─ time ruler + multi-lane clip track + playhead + trim handles ───────┤
//   └──────────────────────────────────────────────────────────────────────┘
//
// EVERYTHING that varies is DATA: which modalities exist, which ops are offered,
// which cleanups apply, lane tone. The surface names no operation and no
// modality in a branch — it walks descriptors. Adding a capability is a DATA row.
//
// NON-NEGOTIABLE INVARIANTS
//   1. UI VIA SHARED PRIMITIVES ONLY (Container / Card / Text / SegmentedControl
//      + the timeline primitives). Zero raw HTML / className.
//   2. NO PACKAGE VOCABULARY in what the user sees — all labels come from DATA.
//   3. BLIND DISPATCH — the surface calls back with an op `action` / ruleset
//      `name` / a `[start,end]`; the panel authors the decision. No fold/EDL here.
//
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';

import type { MaterializedComposition } from '../read-data/compose-timeline';
import type { TranscriptWord } from '../read-data/read-transcript-words';
import {
  actionableOps,
  DEFAULT_EDIT_CAPABILITIES,
  type EditCapabilities,
  type EditModalityDescriptor,
  type EditParamSource,
  type EditRulesetDescriptor,
} from '../read-data/edit-capabilities';
import { AddTracksControl } from './components/AddTracksControl';
import { EditOpBar } from './components/EditOpBar';
import { EditTrackLanes } from './components/EditTrackLanes';
import { EditTranscriptPane } from './components/EditTranscriptPane';
import { Card } from '../../ui/show/card';
import { Container } from '../../ui/show/container';
import { SegmentedControl, type SegmentedControlItem } from '../../ui/show/segmented-control';
import { Text } from '../../ui/show/text';

export type EditTimelineProps = {
  composition: MaterializedComposition;
  transcriptWords: readonly TranscriptWord[];
  /** DATA that drives the surface. Defaults to the source mirror of the rows. */
  capabilities?: EditCapabilities;
  playheadPct: number;
  currentTime: number;
  selectedClipId: string | null;
  /** Current editor state keyed by op param names — resolves actionable ops. */
  paramSource: EditParamSource;
  peaksBySource?: Record<string, number[]>;
  /** Real decoded peaks keyed by clipId (preferred over peaksBySource). */
  peaksByClip?: Record<string, number[]>;
  /** sourceId -> thumbnail URL for filmstrip video lanes. */
  thumbBySource?: Record<string, string>;
  /** Horizontal zoom for the track lanes. */
  zoom?: number;
  /** Timecode shown in the playhead badge. */
  playheadLabel?: string;
  disabled?: boolean;
  onSeek: (seconds: number) => void;
  onSelectClip: (clipId: string) => void;
  /** Author an op by action string (panel resolves declared params). */
  onRunOp: (action: string) => void;
  /** Run a transcript cleanup ruleset by name. */
  onRunRuleset: (rulesetName: string) => void;
  /** Cut a timeline range [start,end] (transcript remove / word-range remove). */
  onRemoveSpan: (startSeconds: number, endSeconds: number) => void;
  /** Commit a trim-handle drag: absolute new source in/out (seconds). */
  onTrim: (clipId: string, inPoint: number, outPoint: number) => void;
  /** Commit a clip body-drag move: the clip's new lane-start time (seconds), plus the
   *  destination track role when the clip was dragged onto a DIFFERENT lane (cross-lane). */
  onMove?: (clipId: string, laneStartSeconds: number, destLaneRole?: string) => void;
  /** Author `videoCount` empty video lanes + `audioCount` empty audio lanes. */
  onAddTracks?: (videoCount: number, audioCount: number) => void;
};

/** Cleanups that belong to a modality, resolved from its `ruleset_refs`. The
 *  ref format is `media-composition.edit-ruleset:<name>`; we match by suffix. */
function rulesetsForModality(
  modality: EditModalityDescriptor | undefined,
  rulesets: readonly EditRulesetDescriptor[],
): EditRulesetDescriptor[] {
  if (!modality?.ruleset_refs) return [];
  const names = new Set(modality.ruleset_refs.map((ref) => ref.slice(ref.lastIndexOf(':') + 1)));
  return rulesets.filter((ruleset) => names.has(ruleset.name));
}

export function EditTimeline({
  composition,
  transcriptWords,
  capabilities = DEFAULT_EDIT_CAPABILITIES,
  playheadPct,
  currentTime,
  selectedClipId,
  paramSource,
  peaksBySource,
  peaksByClip,
  thumbBySource,
  zoom,
  playheadLabel,
  disabled,
  onSeek,
  onSelectClip,
  onRunOp,
  onRunRuleset,
  onRemoveSpan,
  onTrim,
  onMove,
  onAddTracks,
}: EditTimelineProps) {
  const { ops, modalities, rulesets } = capabilities;

  const [activeModalityName, setActiveModalityName] = React.useState(modalities[0]?.name ?? '');
  const activeModality = modalities.find((m) => m.name === activeModalityName) ?? modalities[0];

  const modalityItems: SegmentedControlItem[] = modalities.map((m) => ({ id: m.name, label: m.label }));

  // Ops offered by the active modality that are actionable from current state.
  const barOps = React.useMemo(
    () => actionableOps(ops, paramSource, activeModality?.offered_ops),
    [ops, paramSource, activeModality],
  );

  const modalityRulesets = React.useMemo(
    () => rulesetsForModality(activeModality, rulesets),
    [activeModality, rulesets],
  );

  const seekWord = React.useCallback((word: TranscriptWord) => onSeek(word.start), [onSeek]);

  const authoringPane = React.useMemo(() => {
    if (!activeModality) return null;
    if (activeModality.author_kind === 'transcript') {
      return (
        <EditTranscriptPane
          words={transcriptWords}
          rulesets={modalityRulesets}
          currentTime={currentTime}
          disabled={disabled}
          onSeekWord={seekWord}
          onRemoveRange={onRemoveSpan}
          onRunRuleset={onRunRuleset}
        />
      );
    }
    // Non-transcript modalities (search-assembly, ai-fix, + any future row):
    // named honestly with the ops they offer. Their authoring flow is wired by
    // their own unit; this frame never fakes an action it cannot perform.
    return (
      <Container layout="vertical" gap="sm">
        <Text variant="body" color="faint">{activeModality.notes ?? `Author edits with “${activeModality.label}”.`}</Text>
        <Container layout="horizontal" gap="xs" wrap alignItems="center">
          {activeModality.offered_ops.map((opName) => (
            <Text key={opName} variant="caption" color="faint">{ops[opName]?.label ?? opName}</Text>
          ))}
        </Container>
      </Container>
    );
  }, [activeModality, transcriptWords, modalityRulesets, currentTime, disabled, seekWord, onRemoveSpan, onRunRuleset, ops]);

  return (
    <Container layout="vertical" gap="md">
      {/* Modality switch (DATA) */}
      {modalityItems.length > 0 && (
        <SegmentedControl
          items={modalityItems}
          value={activeModality?.name ?? ''}
          ariaLabel="Editing mode"
          disabled={disabled}
          onValueChange={setActiveModalityName}
        />
      )}

      {/* Active authoring pane */}
      <Card variant="surface" padding="md">{authoringPane}</Card>

      {/* Direct-manipulation op bar (DATA, actionable-filtered) */}
      <EditOpBar ops={barOps} disabled={disabled} onRunOp={onRunOp} />

      {/* Add empty video/audio tracks (Premiere-style) */}
      {onAddTracks ? <AddTracksControl disabled={disabled} onAddTracks={onAddTracks} /> : null}

      {/* The timeline */}
      <EditTrackLanes
        composition={composition}
        playheadPct={playheadPct}
        playheadLabel={playheadLabel}
        selectedClipId={selectedClipId}
        peaksBySource={peaksBySource}
        peaksByClip={peaksByClip}
        thumbBySource={thumbBySource}
        zoom={zoom}
        onSeek={onSeek}
        onSelectClip={onSelectClip}
        onTrim={onTrim}
        onMove={onMove}
      />
    </Container>
  );
}
