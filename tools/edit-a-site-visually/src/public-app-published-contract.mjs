// Public-app source validation stays browser safe. Server adapters resolve the
// current published row and its owner permission on every read.
const MARKETPLACE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*@[a-f0-9]{24}$/;
const TOOL_ID = /^[a-z][a-z0-9-]*:[A-Za-z0-9._:-]{1,160}$/;
const WORKFLOW_ID = /^workflow:[a-z0-9][a-z0-9-]*$/;
// A published kind declares its reference and visitor operations in one place.
// Server adapters supply current-row permission and safe visitor views.
export const publicPublishedCapabilityContracts = Object.freeze({
  'marketplace-configuration': Object.freeze({ shelf: 'configuration', id: MARKETPLACE_ID, operations: Object.freeze(['open']), versionInId: true }),
  'workshop-tool': Object.freeze({ shelf: 'tool', id: TOOL_ID, operations: Object.freeze(['open', 'run']) }),
  'workshop-screen': Object.freeze({ shelf: 'tool', id: TOOL_ID, operations: Object.freeze(['open', 'run']) }),
  'published-workflow': Object.freeze({ shelf: 'workflow', id: WORKFLOW_ID, operations: Object.freeze(['open']) }),
});
export const publicPublishedCapabilityAdapter = kind => publicPublishedCapabilityContracts[kind] ?? null;

export function checkedPublicPublishedReference(ref, access) {
  const contract = publicPublishedCapabilityAdapter(ref.kind);
  if (!contract) return false;
  if (access !== 'public' || !contract.id.test(ref.id) ||
      !contract.operations.includes(ref.operation ?? 'open') ||
      (contract.versionInId && !ref.id.endsWith(`@${ref.version.slice(3, 27)}`))) {
    throw new Error(`The ${ref.kind} reference needs public access and a matching published version.`);
  }
  return true;
}
