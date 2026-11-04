// package-set://bitfield-studio/packages/media-composition/read-data/narration-source.ts
/**
 * #99 Narration authoring. A PURE helper that builds the `add-source` edit-decision for a generated
 * TTS/voiceover clip. The narration audio is produced offline by do-work/tts-narrate.mjs (DATA-selected
 * engine); this turns that artifact into the ONE add-source decision the timeline consumes: an audio
 * clip carrying `narration:true` placed at `startSeconds`, which materialize-edl routes to
 * edl.audio_graph.narration[] and video-compose mixes over the program (L069, no new fold op).
 */

export interface NarrationSourceArgs {
  sourceId: string;
  /** Where on the timeline the voice starts speaking (seconds). */
  startSeconds: number;
  createdAt: string;
  /** PRE-GENERATED path: the stored-bytes address of an already-made narration audio. */
  artifactRef?: string;
  /** Length of a pre-generated clip (seconds); ignored for the text path (render plays the whole clip). */
  durationSeconds?: number;
  /** TEXT path: the render generates the voice from this script with the DATA-selected engine. */
  text?: string;
  producer?: string;
  voice?: string;
  /** Lane to place it on (default 'narration'); the routing is by the narration flag, not the role. */
  laneRole?: string;
  label?: string;
  /** Mix level 0..1+ (default 1). */
  volume?: number;
  /** Human/media metadata carried on the source_ref (media_type etc.), merged verbatim. */
  extraSourceRef?: Record<string, unknown>;
}

/** Build the single `add-source` decision that adds a narration clip. Pure and deterministic. */
export function narrationAddSourceDecision(args: NarrationSourceArgs): {
  action: 'add-source';
  label: string;
  source_ref: Record<string, unknown>;
  span: { start: number; end: number };
  parameters: Record<string, unknown>;
  created_at: string;
} {
  const laneRole = args.laneRole ?? 'narration';
  const label = args.label ?? 'Narration';
  const isText = typeof args.text === 'string' && args.text.trim().length > 0;
  // Text path: estimate the clip length from the word count (~2.5 words/sec) for the timeline block;
  // the render plays the whole generated audio regardless (no in/out trim), so a rough estimate is fine.
  const words = isText ? (args.text as string).trim().split(/\s+/).length : 0;
  const estDur = isText ? Math.max(1, Math.round(words / 2.5)) : Math.max(0, args.durationSeconds ?? 0);
  return {
    action: 'add-source',
    label,
    source_ref: { source_id: args.sourceId, ...(args.artifactRef ? { artifact_ref: args.artifactRef } : {}), role: laneRole, ...(args.extraSourceRef ?? {}) },
    // The source window is the whole clip [0, dur]; lane_start is when it speaks.
    span: { start: 0, end: estDur },
    parameters: {
      lane_role: laneRole,
      lane_start: Math.max(0, args.startSeconds),
      narration: true,
      label,
      ...(isText ? { tts_text: args.text, tts_producer: args.producer ?? 'macos-say', ...(args.voice ? { tts_voice: args.voice } : {}) } : {}),
      ...(Number.isFinite(args.volume) ? { volume: args.volume } : {}),
    },
    created_at: args.createdAt,
  };
}
