export const descriptor = {
  kind: 'learning-mastery-protocol-descriptor',
  schema: 'learning-mastery-protocol-descriptor/v1',
  id: 'protocol:novel',
  defaults: { duration: 17 },
  lifecycle: { initial: 'orient', transitions: { orient: ['execute'], execute: [] } },
  phases: [
    {
      id: 'orient',
      label: 'Orient',
      fields: [{ key: 'constraint', label: 'Constraint' }],
      embeddedSurfaces: [{ schema: 'render-surface-descriptor/v1', package_entry: { package_name: 'documents', entry_name: 'composition-scene' } }],
    },
    { id: 'execute', label: 'Execute', fields: [{ key: 'result', label: 'Result' }] },
  ],
  transitions: [{ id: 'begin', from: 'orient', to: 'execute', actionKey: 'begin', label: 'Begin' }],
  actions: { begin: { target: 'protocol-owner.transition', payload: { mode: 'novel' } } },
  presentation: { accepted: { label: 'Accepted' } },
};
