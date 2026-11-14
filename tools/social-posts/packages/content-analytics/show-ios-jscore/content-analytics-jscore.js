// package-set://bitfield-studio/packages/content-analytics/show-ios-jscore/content-analytics-jscore.js
//
// JSCore-compatible renderer over the serialized content-analytics model.

export function renderContentAnalyticsForJscore(model) {
  const items = Array.isArray(model?.items) ? model.items : [];
  const actions = Array.isArray(model?.actions) ? model.actions : [];
  const blockers = Array.isArray(model?.blockers) ? model.blockers : [];
  return {
    kind: 'screen',
    title: String(model?.title ?? 'Content results'),
    status: String(model?.status ?? 'Empty'),
    primary: {
      value: String(model?.primary?.value ?? 'Waiting'),
      label: String(model?.primary?.label ?? 'Results appear after a finished post reports back.'),
      detail: model?.primary?.detail ? String(model.primary.detail) : null,
    },
    items: items.map((item) => ({
      id: String(item.id),
      title: String(item.title),
      detail: item.detail ? String(item.detail) : '',
      badge: item.badge ? String(item.badge) : null,
    })),
    actions: actions.map((action) => ({
      id: String(action.id),
      label: String(action.label),
      disabled: Boolean(action.blocked),
      reason: action.blockedReason ? String(action.blockedReason) : null,
    })),
    blockers: blockers.map((blocker) => ({
      code: blocker.code ? String(blocker.code) : null,
      message: blocker.message ? String(blocker.message) : 'This result is not ready yet.',
    })),
    proof: {
      renderer: 'content-analytics-jscore',
      modelRevision: String(model?.revision ?? ''),
    },
  };
}

export default renderContentAnalyticsForJscore;
