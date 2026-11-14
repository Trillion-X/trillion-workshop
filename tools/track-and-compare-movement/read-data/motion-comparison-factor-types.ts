export type KnownMotionComparisonIntent = 'same-view' | 'same-phase' | 'same-motion' | 'coaching-review';
export type MotionComparisonIntent = KnownMotionComparisonIntent | (string & {});

export type KnownMotionComparisonFactorKind =
  | 'hand-feature'
  | 'learned-view-factor'
  | 'pose-phase'
  | 'motion-type'
  | 'configured-fallback';
export type MotionComparisonFactorKind = KnownMotionComparisonFactorKind | (string & {});

export type MotionComparisonClipRef = {
  clipId: string;
  label: string;
  mediaRef?: string;
  analysisRef?: string;
  subjectRef?: string;
};

export type MotionIntentWeights = Partial<Record<MotionComparisonFactorKind, number>>;

export type MotionNullCalibration = {
  minimumConfidence: number;
  noMatchReason?: string;
  confidenceBand?: 'low' | 'medium' | 'high' | (string & {});
};

export type MotionCalibrationSummary = {
  minimumConfidence: number;
  confidence: number;
  confidenceBand?: MotionNullCalibration['confidenceBand'];
  passed: boolean;
  noMatchReason?: string;
};

export type MotionWindow = {
  startSeconds: number;
  endSeconds: number;
};

export type MotionSyncFrameOffset = {
  sourceTime: number;
  referenceTime: number;
  offsetSeconds: number;
};

export type MotionSyncWindow = {
  sourceWindow: MotionWindow;
  referenceWindow: MotionWindow;
  phaseAlignment: 'not-measured' | 'weak' | 'usable' | 'strong' | (string & {});
  frameOffsets: MotionSyncFrameOffset[];
};

export type MotionWindowSummary = {
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  midpointSeconds: number;
};

export type MotionSyncEvidenceSummary = {
  sourceWindow: MotionWindowSummary;
  referenceWindow: MotionWindowSummary;
  phaseAlignment: MotionSyncWindow['phaseAlignment'];
  frameOffsetCount: number;
  averageOffsetSeconds: number;
  maxOffsetDriftSeconds: number;
};

export type MotionFactorMeasurement = {
  measurementId?: string;
  factorKind: MotionComparisonFactorKind;
  label: string;
  confidence: number;
  distance?: number;
  reason: string;
  sourceAttachmentIds?: string[];
};

export type MotionSourceRecordRef = {
  packageName: string;
  recordKind: string;
  recordId?: string;
  artifactRef?: {
    multihash?: string;
    cas_address?: string;
  };
  evidenceRole?: 'source-clip' | 'reference-clip' | 'comparison' | (string & {});
};

export type MotionSourceAttachmentRecord = {
  kind: 'motion-source-attachment';
  attachmentId: string;
  attachedToId: string;
  sourceKind: string;
  sourceRef: string;
  sourceRecord?: MotionSourceRecordRef;
  label?: string;
  capturedAt?: string;
  confidence?: number;
  note?: string;
  createdBy?: string;
  createdAt: string;
};

export type MotionComparisonRequestRecord = {
  kind: 'motion-comparison-request';
  requestId: string;
  sourceClip: MotionComparisonClipRef;
  referenceClip: MotionComparisonClipRef;
  intent: MotionComparisonIntent;
  intentWeights: MotionIntentWeights;
  nullCalibration: MotionNullCalibration;
  requestedBy?: string;
  requestedAt: string;
};

export type MotionComparisonResultRecord = {
  kind: 'motion-comparison-result';
  comparisonId: string;
  requestId: string;
  sourceClipId: string;
  referenceClipId: string;
  selectedFactor: MotionFactorMeasurement;
  factorMeasurements: MotionFactorMeasurement[];
  confidence: number;
  nullCalibration: MotionCalibrationSummary;
  sync: MotionSyncWindow;
  syncEvidence: MotionSyncEvidenceSummary;
  tradeoffNote: string;
  noMatchReason?: string;
  renderArtifactRef?: string;
  sourceAttachmentIds?: string[];
  createdAt: string;
};

export type MotionCoachingAttachmentRecord = {
  kind: 'motion-coaching-attachment';
  attachmentId: string;
  comparisonId: string;
  playerId?: string;
  practiceTargetId?: string;
  note: string;
  createdBy?: string;
  createdAt: string;
};

export type MotionComparisonRenderRecord = {
  kind: 'motion-comparison-render';
  comparisonId: string;
  renderMp4IntegrityHash?: string;
  renderMp4ByteLen?: number;
  renderMp4ChunkManifestHash?: string;
  renderMp4ChunkManifestAddr?: string;
  createdAt?: string;
};

export type MotionComparisonRecord =
  | MotionComparisonRequestRecord
  | MotionComparisonResultRecord
  | MotionSourceAttachmentRecord
  | MotionCoachingAttachmentRecord
  | MotionComparisonRenderRecord;

export type MotionComparisonState = {
  requests: MotionComparisonRequestRecord[];
  results: MotionComparisonResultRecord[];
  sourceAttachments: MotionSourceAttachmentRecord[];
  coachingAttachments: MotionCoachingAttachmentRecord[];
  renders: MotionComparisonRenderRecord[];
};

export type MotionComparisonView = {
  request: MotionComparisonRequestRecord;
  result?: MotionComparisonResultRecord;
  sourceAttachments: MotionSourceAttachmentRecord[];
  coachingAttachments: MotionCoachingAttachmentRecord[];
  status: 'requested' | 'matched' | 'no-match';
  factorSummary: string;
  syncSummary: string;
  calibrationSummary: string;
  /** The rendered side-by-side mp4's CAS record, joined by comparisonId. Resolved to
   *  a playable URL by useRenderVideoUrl (single-chunk = direct /cas/ URL; multichunk =
   *  client-side reassembled object URL). Undefined until the render record exists. */
  render?: MotionComparisonRenderRecord;
};
