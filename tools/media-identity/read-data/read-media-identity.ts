import {
  evidencePayloads,
  readEvidenceProjection,
  type EvidenceBlocker,
  type EvidencePipelineConfig,
} from '../../record-voice-and-meetings/read-data/content-media-evidence';

export type MediaIdentityProfile = {
  kind?: string;
  profile_id?: string;
  label?: string;
  settings?: Record<string, unknown>;
  thresholds?: Record<string, unknown>;
  models?: Record<string, unknown>;
  credential_handle_refs?: unknown[];
  updated_at?: string;
};

export type MediaIdentityRequest = {
  kind?: string;
  request_id?: string;
  source?: { media_type?: string; artifact_ref?: { multihash?: string; cas_address?: string } };
  identity_profile_ref?: Record<string, unknown>;
  lanes?: Record<string, boolean>;
  requested_at?: string;
};

export type MediaIdentitySignature = {
  kind?: string;
  signature_id?: string;
  source_fingerprint?: string;
  modality?: string;
  source_span?: { start?: number; end?: number };
  signature_artifact_ref?: { multihash?: string; cas_address?: string };
  quality?: { score?: number };
};

export type MediaIdentityCluster = {
  kind?: string;
  cluster_id?: string;
  modality_mix?: Record<string, number>;
  member_signature_refs?: unknown[];
  profile_binding_refs?: unknown[];
  status?: string;
  updated_at?: string;
};

export type MediaIdentityProfileBinding = {
  kind?: string;
  binding_id?: string;
  cluster_ref?: Record<string, unknown>;
  profile_ref?: Record<string, unknown>;
  profile_label?: string;
  approved_by_ref?: Record<string, unknown>;
  status?: string;
  bound_at?: string;
};

export type MediaIdentityMatch = {
  kind?: string;
  match_id?: string;
  source_fingerprint?: string;
  signature_ref?: Record<string, unknown>;
  cluster_ref?: Record<string, unknown>;
  profile_ref?: Record<string, unknown>;
  source_span?: { start?: number; end?: number };
  confidence?: number;
};

export type MediaIdentityError = {
  kind?: string;
  request_id?: string;
  code?: string;
  message?: string;
  observed_at?: string;
};

export type MediaIdentityEvidence = {
  config: EvidencePipelineConfig | null;
  blockers: EvidenceBlocker[];
  profiles: MediaIdentityProfile[];
  requests: MediaIdentityRequest[];
  signatures: MediaIdentitySignature[];
  clusters: MediaIdentityCluster[];
  profileBindings: MediaIdentityProfileBinding[];
  matches: MediaIdentityMatch[];
  errors: MediaIdentityError[];
};

export function readMediaIdentityEvidence(rows: unknown): MediaIdentityEvidence {
  const projection = readEvidenceProjection(rows, 'media-identity');
  return {
    config: projection.config,
    blockers: projection.blockers,
    profiles: evidencePayloads<MediaIdentityProfile>(projection, 'profiles'),
    requests: evidencePayloads<MediaIdentityRequest>(projection, 'requests'),
    signatures: evidencePayloads<MediaIdentitySignature>(projection, 'signatures'),
    clusters: evidencePayloads<MediaIdentityCluster>(projection, 'clusters'),
    profileBindings: evidencePayloads<MediaIdentityProfileBinding>(projection, 'profileBindings'),
    matches: evidencePayloads<MediaIdentityMatch>(projection, 'matches'),
    errors: evidencePayloads<MediaIdentityError>(projection, 'errors'),
  };
}
