export function renderAccountDashboardForJscore(model) {
  const fields = Array.isArray(model?.fields) ? model.fields : [];
  const actions = Array.isArray(model?.actions) ? model.actions : [];
  return {
    kind: 'screen',
    state: model?.state ?? 'empty',
    title: fields.find((field) => field.kind === 'subject')?.label ?? 'Account',
    fields: fields.map((field) => ({
      id: field.id,
      kind: field.kind,
      label: field.label,
      text: field.text,
    })),
    actions: actions.map((action) => ({
      id: action.id,
      label: action.label,
      disabled: Boolean(action.disabled),
      reason: action.disabledReason ?? null,
    })),
    proof: {
      renderer: 'account-dashboard-jscore',
      descriptorCount: model?.proof?.descriptorCount ?? 0,
    },
  };
}
