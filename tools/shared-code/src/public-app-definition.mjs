// A public app declares the visitor actions it accepts. The host resolves the
// installation before calling these functions; visitor input never chooses a
// record kind, owner, Space, or installation.
const ID = /^[a-z][a-z0-9-]{1,79}$/;
const RECORD_KIND = /^[a-z][a-z0-9._-]{1,99}$/;
const FIELD_TYPES = new Set(['text', 'email', 'number', 'boolean', 'date']);

export function checkedPublicAppDefinition(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Give a public app definition.');
  if (!ID.test(input.id ?? '')) throw new Error('The app needs a valid id.');
  if (typeof input.version !== 'string' || !input.version.trim() || input.version.length > 100) throw new Error('The app needs a version.');
  if (!Array.isArray(input.actions) || input.actions.length > 40) throw new Error('Declare up to 40 visitor actions.');
  const seenActions = new Set();
  const actions = input.actions.map(action => {
    if (!ID.test(action?.id ?? '') || seenActions.has(action.id)) throw new Error('Each visitor action needs a distinct valid id.');
    seenActions.add(action.id);
    if (!RECORD_KIND.test(action.record_kind ?? '')) throw new Error(`The ${action.id} action needs a valid record kind.`);
    if (!Array.isArray(action.fields) || action.fields.length > 40) throw new Error(`The ${action.id} action has too many fields.`);
    const seenFields = new Set();
    const fields = action.fields.map(field => {
      if (!ID.test(field?.id ?? '') || seenFields.has(field.id)) throw new Error(`The ${action.id} action has a repeated or invalid field.`);
      if (!FIELD_TYPES.has(field.type)) throw new Error(`The ${field.id} field has an unsupported type.`);
      seenFields.add(field.id);
      return { id: field.id, type: field.type, required: field.required === true };
    });
    return { id: action.id, record_kind: action.record_kind, fields };
  });
  return { id: input.id, version: input.version.trim(), actions };
}

export function checkedVisitorAction(definition, actionId, input) {
  const action = checkedPublicAppDefinition(definition).actions.find(row => row.id === actionId);
  if (!action) throw new Error('This app does not accept that action.');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Give the action fields.');
  const allowed = new Set(action.fields.map(field => field.id));
  if (Object.keys(input).some(key => !allowed.has(key))) throw new Error('This action has an unknown field.');
  const body = {};
  for (const field of action.fields) {
    const value = input[field.id];
    if (value === undefined || value === null || value === '') {
      if (field.required) throw new Error(`The ${field.id} field is needed.`);
      continue;
    }
    if (field.type === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`The ${field.id} field must be true or false.`);
    } else if (field.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`The ${field.id} field must be a number.`);
    } else {
      if (typeof value !== 'string' || value.length > 4000) throw new Error(`The ${field.id} field must be short text.`);
      if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error(`The ${field.id} field must be an email address.`);
      if (field.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`The ${field.id} field must be a date.`);
    }
    body[field.id] = value;
  }
  return { kind: action.record_kind, action_id: action.id, body };
}

export function checkedInstallationContext(input) {
  if (input?.kind === 'private' && typeof input.id === 'string' && input.id) return { kind: 'private', id: input.id };
  if (input?.kind === 'space' && typeof input.id === 'string' && input.id) return { kind: 'space', id: input.id };
  throw new Error('Choose your private Trillion or a pursuit.');
}
