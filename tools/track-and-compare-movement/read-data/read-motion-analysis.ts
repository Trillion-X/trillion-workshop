import {
  evidencePayloads,
  readEvidenceProjection,
  type EvidenceBlocker,
  type EvidencePipelineConfig,
} from '../../record-voice-and-meetings/read-data/content-media-evidence';

export type MotionAnalysisRequest = {
  kind?: string;
  request_id?: string;
  sources?: Array<{ role?: string; artifact_ref?: { multihash?: string; cas_address?: string } }>;
  lanes?: Record<string, boolean>;
  requested_at?: string;
};

export type MotionTrack = {
  kind?: string;
  track_id?: string;
  source_fingerprint?: string;
  subject_ref?: Record<string, unknown>;
  keypoint_schema?: Record<string, unknown>;
  time_range?: { start?: number; end?: number };
  sample_rate?: number;
  track_artifact_ref?: { multihash?: string; cas_address?: string };
};

export type MotionPhase = {
  kind?: string;
  phase_id?: string;
  track_ref?: Record<string, unknown>;
  label?: string;
  label_ref?: Record<string, unknown>;
  time_range?: { start?: number; end?: number };
  phase_taxonomy_ref?: Record<string, unknown>;
};

export type MotionAlignment = {
  kind?: string;
  alignment_id?: string;
  source_span_refs?: unknown[];
  method?: string;
  score?: number;
  transform_artifact_ref?: { multihash?: string; cas_address?: string };
};

export type MotionComparison = {
  kind?: string;
  comparison_id?: string;
  alignment_refs?: unknown[];
  summary?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  evidence_refs?: unknown[];
  output_artifact_refs?: unknown[];
};

export type MotionError = {
  kind?: string;
  request_id?: string;
  code?: string;
  message?: string;
  observed_at?: string;
};

export type MotionAnalysisEvidence = {
  config: EvidencePipelineConfig | null;
  blockers: EvidenceBlocker[];
  requests: MotionAnalysisRequest[];
  tracks: MotionTrack[];
  phases: MotionPhase[];
  alignments: MotionAlignment[];
  comparisons: MotionComparison[];
  errors: MotionError[];
};

export function readMotionAnalysisEvidence(rows: unknown): MotionAnalysisEvidence {
  const projection = readEvidenceProjection(rows, 'motion-analysis');
  return {
    config: projection.config,
    blockers: projection.blockers,
    requests: evidencePayloads<MotionAnalysisRequest>(projection, 'requests'),
    tracks: evidencePayloads<MotionTrack>(projection, 'tracks'),
    phases: evidencePayloads<MotionPhase>(projection, 'phases'),
    alignments: evidencePayloads<MotionAlignment>(projection, 'alignments'),
    comparisons: evidencePayloads<MotionComparison>(projection, 'comparisons'),
    errors: evidencePayloads<MotionError>(projection, 'errors'),
  };
}
