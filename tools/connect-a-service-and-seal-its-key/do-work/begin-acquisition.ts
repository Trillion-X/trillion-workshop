import {
  connectServiceWithCredentialHandle,
  type ServiceConnectionSeams,
} from '@/packages/service-connections/do-work/connect-service';
import { engineSeams } from '@/packages/service-connections/do-work/engine-seams';
import {
  deriveConnectionInstanceId,
  type ServiceAcquireDescriptor,
  type ServiceConnectionTarget,
  type ServiceEnvironment,
} from '@/packages/service-connections/read-data/read-service-connection-options';

export type BeginAcquisitionDescriptor = {
  connection: ServiceConnectionTarget;
  acquire: ServiceAcquireDescriptor;
  existingConnectionIds?: Iterable<string>;
  environmentId?: string | null;
  environments?: readonly ServiceEnvironment[];
};

export type BeginAcquisitionOutcome = {
  account_label: string;
  resource_refs: string[];
  credential_handle_ref: string;
  connection_id: string;
};

function outputRecord(reply: unknown): Record<string, unknown> {
  const record = reply && typeof reply === 'object' ? reply as Record<string, unknown> : {};
  const output = record.output;
  return output && typeof output === 'object' && !Array.isArray(output)
    ? output as Record<string, unknown>
    : record;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function readStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

export async function beginAcquisition(
  descriptor: BeginAcquisitionDescriptor,
  seams: ServiceConnectionSeams = engineSeams(),
): Promise<BeginAcquisitionOutcome> {
  const reply = await seams.runOwnerAction(
    'acquire-credential',
    { acquire: descriptor.acquire },
    { includeOutput: true },
  );
  const result = outputRecord(reply);
  const accountLabel = readString(result, 'account_label');
  const credentialHandleRef = readString(result, 'credential_handle_ref');
  const resourceRefs = readStringArray(result, 'resource_refs');
  if (!accountLabel || !credentialHandleRef) {
    throw new Error('Sign-in finished without an account name or usable access. Nothing was connected.');
  }

  const connectionId = deriveConnectionInstanceId(
    descriptor.connection.serviceVendor,
    accountLabel,
    new Set(descriptor.existingConnectionIds ?? []),
  );
  await connectServiceWithCredentialHandle({
    connection: {
      ...descriptor.connection,
      id: connectionId,
      // AGNOSTIC serviceName stays static (e.g. "GitHub", "OpenAI"). Account
      // identity (email/handle) is stored separately in accountLabel for
      // multi-account grouping — the UI renders both: primary serviceName +
      // secondary accountLabel.
      accountLabel,
      resourceRefs,
    },
    credentialHandleRef,
    environmentId: descriptor.environmentId,
    environments: descriptor.environments,
  }, undefined, seams);

  return {
    account_label: accountLabel,
    resource_refs: resourceRefs,
    credential_handle_ref: credentialHandleRef,
    connection_id: connectionId,
  };
}
