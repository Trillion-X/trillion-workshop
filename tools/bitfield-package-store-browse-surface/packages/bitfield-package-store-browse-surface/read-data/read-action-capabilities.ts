type UnknownRecord = Record<string, unknown>;

export type ActionPreflightRow = {
  detail: string;
  label: string;
  owner_package?: string;
  provider_package?: string;
  refs: string[];
  status_label: string;
};

export type ActionPreflightView = {
  rows: ActionPreflightRow[];
};

type CredentialRequirement = {
  credential_handle_ref: string;
  detail: string;
  environment_variable?: string;
  label: string;
  owner_package: string;
  provider_package: string;
  requirement_ref: string;
  status_label: string;
  target_refs: string[];
};

type ActionRequirement = {
  action_ref: string;
  label: string;
  required_credential_refs: string[];
  target_refs: string[];
};

type ActionCapabilityRecords = {
  action_requirements: ActionRequirement[];
  credential_requirements: CredentialRequirement[];
};

export function readActionPreflight(
  value: unknown,
  request: {
    caller_data_refs?: string[];
    owner_target_refs?: string[];
    quote_target_refs?: string[];
    target_refs?: string[];
  },
): ActionPreflightView {
  const records = readActionCapabilityRecords(value);
  const targetRefs = cleanStrings(request.target_refs);
  const neededCredentialRefs = new Set<string>();

  for (const action of records.action_requirements) {
    if (intersects(action.target_refs, targetRefs)) {
      for (const ref of action.required_credential_refs) neededCredentialRefs.add(ref);
    }
  }

  const rows: ActionPreflightRow[] = [
    ...cleanStrings(request.caller_data_refs).map((ref) => ({
      detail: 'The caller must provide this value before the action request is complete.',
      label: 'Caller data needed',
      refs: [ref],
      status_label: 'waiting for input',
    })),
    ...cleanStrings(request.owner_target_refs).map((ref) => ({
      detail: 'The account owner must complete this step before the package action can run.',
      label: 'Account step needed',
      refs: [ref],
      status_label: 'blocked by owner step',
    })),
    ...cleanStrings(request.quote_target_refs).map((ref) => ({
      detail: 'The deal owner must reserve or prove this price step before the package action can run.',
      label: 'Price step needed',
      refs: [ref],
      status_label: 'blocked by price step',
    })),
  ];

  for (const requirement of records.credential_requirements) {
    if (!neededCredentialRefs.has(requirement.requirement_ref) && !intersects(requirement.target_refs, targetRefs)) {
      continue;
    }
    rows.push({
      detail: requirement.detail,
      label: requirement.label,
      owner_package: requirement.owner_package,
      provider_package: requirement.provider_package,
      refs: cleanStrings([
        requirement.requirement_ref,
        requirement.credential_handle_ref,
        requirement.environment_variable,
      ]),
      status_label: requirement.status_label,
    });
  }

  return { rows };
}

function readActionCapabilityRecords(value: unknown): ActionCapabilityRecords {
  if (!isRecord(value)) return { action_requirements: [], credential_requirements: [] };
  return {
    action_requirements: readActionRequirements(value.action_requirements),
    credential_requirements: readCredentialRequirements(value.credential_requirements),
  };
}

function readActionRequirements(value: unknown): ActionRequirement[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const actionRef = stringField(item.action_ref);
    const label = stringField(item.label);
    const targetRefs = cleanStrings(item.target_refs);
    if (!actionRef || !label || targetRefs.length === 0) return [];
    return [{
      action_ref: actionRef,
      label,
      required_credential_refs: cleanStrings(item.required_credential_refs),
      target_refs: targetRefs,
    }];
  });
}

function readCredentialRequirements(value: unknown): CredentialRequirement[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const requirementRef = stringField(item.requirement_ref);
    const credentialHandleRef = stringField(item.credential_handle_ref);
    const detail = stringField(item.detail);
    const label = stringField(item.label);
    const ownerPackage = stringField(item.owner_package);
    const providerPackage = stringField(item.provider_package);
    const statusLabel = stringField(item.status_label);
    const targetRefs = cleanStrings(item.target_refs);
    if (
      !requirementRef ||
      !credentialHandleRef ||
      !detail ||
      !label ||
      !ownerPackage ||
      !providerPackage ||
      !statusLabel ||
      targetRefs.length === 0
    ) {
      return [];
    }
    return [{
      credential_handle_ref: credentialHandleRef,
      detail,
      environment_variable: stringField(item.environment_variable),
      label,
      owner_package: ownerPackage,
      provider_package: providerPackage,
      requirement_ref: requirementRef,
      status_label: statusLabel,
      target_refs: targetRefs,
    }];
  });
}

function cleanStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function intersects(left: string[], right: string[]) {
  return left.some((item) => right.includes(item));
}

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringField(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

