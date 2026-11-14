export type RenderSurfaceDescriptor = {
  schema: 'render-surface-descriptor/v1';
  package_entry: { package_name: string; entry_name: string };
  surface_input?: Record<string, unknown>;
  material_target?: string;
  target?: string;
};

export type LearningMasteryProtocolDescriptor = {
  kind: 'learning-mastery-protocol-descriptor';
  schema: 'learning-mastery-protocol-descriptor/v1';
  id: string;
  defaults: Record<string, unknown>;
  lifecycle: {
    initial: string;
    transitions: Record<string, string[]>;
  };
  phases: Array<{
    id: string;
    label: string;
    detail?: string;
    fields: Array<{
      key: string;
      label: string;
      presentation?: string;
    }>;
    embeddedSurfaces?: RenderSurfaceDescriptor[];
  }>;
  transitions: Array<{
    id: string;
    from: string;
    to: string;
    actionKey: string;
    label: string;
  }>;
  actions: Record<string, {
    target: string;
    payload: Record<string, unknown>;
  }>;
  presentation: Record<string, { label: string; tone?: string }>;
};

export type LearningMasteryProtocolState = {
  kind: 'learning-mastery-protocol-state';
  protocol_ref: string;
  state_ref: string;
  revision: number;
  phase: string;
  values: Record<string, unknown>;
};

export type AcceptedProgressionDecisionReceipt = {
  kind: 'accepted-progression-decision-receipt';
  decision_key: string;
  confidence: number;
  provenance: Record<string, unknown>;
  adjustments: Record<string, unknown>;
  accepted_at: string;
};
