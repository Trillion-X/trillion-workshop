export type JsonRecord = Record<string, unknown>;

export type SemanticSurfaceState = {
  state: string;
  records: JsonRecord[];
  fields: JsonRecord[];
  views: JsonRecord[];
  relationships: JsonRecord[];
  rules: JsonRecord[];
  actions: JsonRecord[];
  linkedRecords: JsonRecord[];
  issues: string[];
};

function objectList(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is JsonRecord => !!entry && typeof entry === 'object' && !Array.isArray(entry))
    : [];
}

function stateName(value: unknown): string {
  return typeof value === 'string' && value ? value : 'ready';
}

export function materializeSemanticSurface(input: JsonRecord): SemanticSurfaceState {
  return {
    state: stateName(input.state),
    records: objectList(input.records),
    fields: objectList(input.fields),
    views: objectList(input.views),
    relationships: objectList(input.relationships),
    rules: objectList(input.rules),
    actions: objectList(input.actions),
    linkedRecords: objectList(input.linkedRecords),
    issues: Array.isArray(input.issues)
      ? input.issues.filter((issue): issue is string => typeof issue === 'string')
      : [],
  };
}

export function semanticFingerprint(state: SemanticSurfaceState): JsonRecord {
  return {
    state: state.state,
    recordIds: state.records.map((record) => record.id),
    fieldIds: state.fields.map((field) => field.id),
    viewIds: state.views.map((view) => view.id),
    relationshipIds: state.relationships.map((relationship) => relationship.id),
    ruleIds: state.rules.map((rule) => rule.id),
    actionIds: state.actions.map((action) => action.id),
    linkedRecordIds: state.linkedRecords.map((record) => record.id),
    disabledReasons: state.actions.map((action) => {
      const availability = action.availability as JsonRecord | undefined;
      return availability?.disabled_reason;
    }).filter(Boolean),
    issues: state.issues,
  };
}
