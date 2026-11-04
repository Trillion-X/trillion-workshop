// Human setup actions and AI calls share the same server-owned request, identity, policy and provider checkpoints.
const source = { type: 'string', minLength: 1, description: 'A source_id from the account setup prerequisite, such as native-ios' };
export const setupAccessTools = call => [
  { name: 'read_setup_access', description: 'Read this account\'s installation-access request, provider delivery state and recovery. An invitation or provider install report is not completion of Trillion setup; the native account sign-in proves that separately.',
    inputSchema: { type: 'object', required: ['source_id'], additionalProperties: false, properties: { source_id: source } },
    run: ({ source_id }) => call(`/setup-access?source_id=${encodeURIComponent(source_id)}`) },
  { name: 'change_setup_access', description: 'Prepare, recheck/retry or cancel this account\'s required installation access. The server resolves its actual requirements, verified email and operator policy. Set consent true only when the person has requested the access invitation; otherwise existing recorded signup consent must permit it. This can arrange an external provider invitation. Cancel stops future steps; an invitation already started may still arrive and existing provider access is unchanged. Never supply a different recipient or mark installation complete.',
    inputSchema: { type: 'object', required: ['source_id', 'operation'], additionalProperties: false,
      properties: { source_id: source, operation: { type: 'string', enum: ['prepare', 'retry', 'cancel'] }, request_id: { type: 'string', description: 'Current request_id from read_setup_access; required to cancel' }, consent: { type: 'boolean' } } },
    run: input => call('/setup-access', input) },
];
export const setupAccessAnnotations = {
  read_setup_access: { title: 'Read installation access', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  change_setup_access: { title: 'Arrange or cancel installation access', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};
