export const BROWSER_INTENT_CLASSES = Object.freeze([
  'authenticated_browser',
  'public_headless',
  'visible_personal_browser',
]);

export class BrowserSessionRouteError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BrowserSessionRouteError';
    this.code = code;
  }
}

export function selectBrowserSessionRoute(request, policyDoc) {
  assertObject(request, 'request');
  assertObject(policyDoc, 'routing policy');
  if (!Array.isArray(policyDoc.routes)) {
    throw new BrowserSessionRouteError('invalid_routing_policy', 'Browsing options are unavailable because their setup is incomplete.');
  }
  if (!BROWSER_INTENT_CLASSES.includes(request.intent_class)) {
    throw new BrowserSessionRouteError('unknown_intent_class', 'The requested kind of browsing is not supported.');
  }

  if (request.intent_class === 'visible_personal_browser') {
    validateExactPersonalBrowserGrant(request.personal_browser_grant, policyDoc.personal_browser_policy);
    const exactRoute = policyDoc.routes.find((route) =>
      route?.surface_class === 'visible_personal_browser'
      && route?.provider_id === request.personal_browser_grant.exact_provider_ref
    );
    if (!exactRoute) {
      throw new BrowserSessionRouteError(
        'personal_browser_provider_unavailable',
        'The exact personal browser session requested for this task is not available.',
      );
    }
    return validateAndProjectRoute(exactRoute, policyDoc);
  }

  const matches = policyDoc.routes.filter((route) => route?.intent_class === request.intent_class);
  if (matches.length === 0) {
    throw new BrowserSessionRouteError('route_unavailable', 'No safe browsing option is available for this request.');
  }
  if (matches.length !== 1) {
    throw new BrowserSessionRouteError('ambiguous_route', 'More than one browsing option matches this request.');
  }
  return validateAndProjectRoute(matches[0], policyDoc);
}

export function validateIsolatedSurfaceProof(route, proof) {
  assertObject(route, 'route');
  if (route.surface_class !== 'task_isolated_agent_screen') return { usable: true, route };
  assertObject(proof, 'surface proof');
  const required = route.requires_surface_proof ?? {};
  const missing = [];
  if (required.surface_identity && !nonEmpty(proof.surface_identity)) missing.push('surface_identity');
  if (required.task_isolation && proof.isolation_scope !== 'task') missing.push('isolation_scope=task');
  if (required.independent_pointer && proof.independent_pointer !== true) missing.push('independent_pointer=true');
  if (required.independent_keyboard && proof.independent_keyboard !== true) missing.push('independent_keyboard=true');
  if (required.input_focus_identity && !nonEmpty(proof.input_focus_identity)) missing.push('input_focus_identity');
  if (missing.length > 0) {
    throw new BrowserSessionRouteError(
      'isolated_surface_unproven',
      'Signed-in browsing needs a separate screen for this task with its own pointer, keyboard, and focus.',
    );
  }
  if (proof.visible_on_personal_display === true) {
    throw new BrowserSessionRouteError('personal_display_forbidden', 'A personal browser window cannot be used as the separate screen for this task.');
  }
  return {
    usable: true,
    route,
    surface: {
      surface_identity: proof.surface_identity,
      isolation_scope: proof.isolation_scope,
      input_focus_identity: proof.input_focus_identity,
      independent_pointer: true,
      independent_keyboard: true,
      visible_on_personal_display: false,
    },
  };
}

function validateAndProjectRoute(route, policyDoc) {
  assertObject(route, 'route');
  for (const key of ['id', 'intent_class', 'surface_class', 'owner_package', 'owner_capability_ref', 'provider_id', 'provider_kind']) {
    if (!nonEmpty(route[key])) throw new BrowserSessionRouteError('invalid_route', 'The selected browsing option has incomplete setup.');
  }
  if ((policyDoc.forbidden_provider_kinds ?? []).includes(route.provider_kind)) {
    throw new BrowserSessionRouteError('forbidden_provider_kind', 'The selected browsing option is not allowed by the current safety settings.');
  }
  return {
    route_id: route.id,
    intent_class: route.intent_class,
    surface_class: route.surface_class,
    owner_package: route.owner_package,
    owner_capability_ref: route.owner_capability_ref,
    provider_id: route.provider_id,
    provider_kind: route.provider_kind,
    status_operation: route.status_operation,
    ...(route.execution_operation ? { execution_operation: route.execution_operation } : {}),
    ...(route.execution_operations ? { execution_operations: [...route.execution_operations] } : {}),
    ...(route.requires_surface_proof ? { requires_surface_proof: { ...route.requires_surface_proof } } : {}),
  };
}

function validateExactPersonalBrowserGrant(grant, policy) {
  assertObject(policy, 'personal browser policy');
  if (policy.eligible_by_default !== false || policy.requires_exact_founder_request !== true) {
    throw new BrowserSessionRouteError('invalid_personal_browser_policy', 'Personal browser protection is not safely configured.');
  }
  if (grant === null || typeof grant !== 'object' || Array.isArray(grant)) {
    throw new BrowserSessionRouteError('personal_browser_not_authorized', 'This personal browser session was not explicitly requested.');
  }
  for (const field of policy.required_grant_fields ?? []) {
    if (!nonEmpty(grant[field])) {
      throw new BrowserSessionRouteError('personal_browser_not_authorized', 'The request for the exact personal browser session is incomplete.');
    }
  }
  if (!nonEmpty(policy.request_authority_ref) || grant.requested_by !== policy.request_authority_ref) {
    throw new BrowserSessionRouteError('personal_browser_not_authorized', 'The exact personal browser session was not requested by an allowed person.');
  }
}

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BrowserSessionRouteError('invalid_input', 'Required browsing details are missing.');
  }
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
