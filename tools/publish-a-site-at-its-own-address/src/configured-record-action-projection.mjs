export function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function text(value, fallback = '') {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

export function objectList(value) {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

export function stringList(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

export function validateConfiguredRecordActionProjection(config) {
  const errors = [];
  if (!isObject(config)) errors.push('config must be an object');
  if (config?.kind !== 'configured-record-action-projection') {
    errors.push('kind must be configured-record-action-projection');
  }

  const actionIds = new Set();
  for (const action of objectList(config?.action_bindings)) {
    const id = text(action.id);
    if (!id) errors.push('action binding missing id');
    if (actionIds.has(id)) errors.push(`duplicate action binding ${id}`);
    actionIds.add(id);
    if (!text(action.role_ref)) errors.push(`${id || 'action'} missing role_ref`);
    if (!text(action.target)) errors.push(`${id || 'action'} missing target`);
    if (!text(action.effect_role_ref)) errors.push(`${id || 'action'} missing effect_role_ref`);
    for (const binding of objectList(action.input_bindings)) {
      if (!text(binding.key)) errors.push(`${id || 'action'} input binding missing key`);
      if (!text(binding.source)) errors.push(`${id || 'action'} input binding missing source`);
      if (binding.path !== undefined && stringList(binding.path).length !== binding.path.length) {
        errors.push(`${id || 'action'} input binding path must be string segments`);
      }
    }
  }

  const effectRoles = new Set(objectList(config?.effect_receipt_roles).map((role) => text(role.role_ref)).filter(Boolean));
  for (const action of objectList(config?.action_bindings)) {
    const effectRole = text(action.effect_role_ref);
    if (effectRole && !effectRoles.has(effectRole)) errors.push(`${text(action.id, 'action')} references missing effect role ${effectRole}`);
  }

  for (const descriptor of objectList(config?.projection_descriptors)) {
    if (!text(descriptor.id)) errors.push('projection descriptor missing id');
    for (const fieldRole of objectList(descriptor.field_roles)) {
      if (!text(fieldRole.role)) errors.push(`${text(descriptor.id, 'projection')} field role missing role`);
      if (!text(fieldRole.field_ref)) errors.push(`${text(descriptor.id, 'projection')} field role missing field_ref`);
    }
    for (const actionRole of objectList(descriptor.action_roles)) {
      const actionRef = text(actionRole.action_ref);
      if (!text(actionRole.role)) errors.push(`${text(descriptor.id, 'projection')} action role missing role`);
      if (!actionIds.has(actionRef)) errors.push(`${text(descriptor.id, 'projection')} references missing action ${actionRef}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function recordEvent({ subjectRef, eventRole, fieldFacts = {}, relationshipFacts = [], correlationRef = null, labelRef = null }) {
  if (!subjectRef) throw new Error('subjectRef is required');
  if (!eventRole) throw new Error('eventRole is required');
  return {
    kind: 'record-event',
    subject_ref: subjectRef,
    event_role: eventRole,
    field_facts: fieldFacts,
    relationship_facts: relationshipFacts,
    correlation_ref: correlationRef,
    human_label_ref: labelRef,
  };
}

export function effectReceipt({ correlationRef, effectRole, ok, fields = {}, errorRef = null, processSessionRef = null }) {
  if (!correlationRef) throw new Error('correlationRef is required');
  if (!effectRole) throw new Error('effectRole is required');
  return {
    kind: 'effect-receipt',
    correlation_ref: correlationRef,
    effect_role: effectRole,
    ok: ok === true,
    fields,
    error_ref: errorRef,
    process_session_ref: processSessionRef,
  };
}

export function foldSubjectProjection(events = [], receipts = [], config = {}) {
  const preserveByEffectRole = new Map(
    objectList(config.effect_receipt_roles).map((role) => [
      text(role.role_ref),
      new Set(stringList(role.preserve_fields_on_failure)),
    ]),
  );
  const subjects = new Map();
  const eventByCorrelation = new Map();

  for (const event of events) {
    if (event?.kind !== 'record-event') continue;
    const subjectRef = text(event.subject_ref);
    if (!subjectRef) continue;
    const current = subjects.get(subjectRef) ?? { subject_ref: subjectRef, fields: {}, relationships: [], history: [] };
    current.fields = { ...current.fields, ...(isObject(event.field_facts) ? event.field_facts : {}) };
    current.relationships = [...current.relationships, ...objectList(event.relationship_facts)];
    current.history = [...current.history, event];
    subjects.set(subjectRef, current);
    const correlationRef = text(event.correlation_ref);
    if (correlationRef) eventByCorrelation.set(correlationRef, subjectRef);
  }

  for (const receipt of receipts) {
    if (receipt?.kind !== 'effect-receipt') continue;
    const subjectRef = eventByCorrelation.get(text(receipt.correlation_ref));
    if (!subjectRef) continue;
    const current = subjects.get(subjectRef) ?? { subject_ref: subjectRef, fields: {}, relationships: [], history: [] };
    const preserve = preserveByEffectRole.get(text(receipt.effect_role)) ?? new Set();
    const nextFields = { ...current.fields };
    for (const [key, value] of Object.entries(isObject(receipt.fields) ? receipt.fields : {})) {
      if (receipt.ok || !preserve.has(key) || nextFields[key] === undefined) nextFields[key] = value;
    }
    current.fields = nextFields;
    current.history = [...current.history, receipt];
    subjects.set(subjectRef, current);
  }

  return [...subjects.values()];
}

export function projectRows(subjects = [], descriptor = {}) {
  const fieldRoles = objectList(descriptor.field_roles);
  const actionRoles = objectList(descriptor.action_roles);
  const viewRoles = objectList(descriptor.view_roles);
  return subjects.map((subject) => ({
    kind: 'projection-row',
    projection_ref: text(descriptor.id),
    subject_ref: subject.subject_ref,
    field_roles: fieldRoles.map((role) => ({
      role: text(role.role),
      field_ref: text(role.field_ref),
      value: subject.fields?.[text(role.role)] ?? subject.fields?.[text(role.field_ref)] ?? null,
    })),
    action_roles: actionRoles.map((role) => ({ role: text(role.role), action_ref: text(role.action_ref) })),
    view_roles: viewRoles.map((role) => ({ ...role })),
    history: subject.history ?? [],
  }));
}
