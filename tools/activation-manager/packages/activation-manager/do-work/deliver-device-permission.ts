import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import packageContract from '../things-to-store-and-run.json' with { type: 'json' };
import { record, text } from '../read-data/capability-state-records';
import {
  buildOwnerActionWorkflow,
  readWorkflowRequestDescriptor,
  type WorkflowRequestDescriptor,
} from './build-owner-action-workflow';

export interface DeliverDevicePermissionInput {
  callbackUrl?: string;
  state?: string | null;
  verifierInput?: unknown;
  activationMaterial?: unknown;
  descriptor?: unknown;
  packet?: Record<string, unknown>;
}

export class DevicePermissionDeliveryError extends Error {
  constructor(
    message: string,
    public readonly publicCode = 502,
  ) {
    super(message);
  }
}

function packageRecords(): readonly Record<string, unknown>[] {
  return Array.isArray(packageContract.things)
    ? packageContract.things.map(record)
    : [];
}

function descriptorFromPackage(): WorkflowRequestDescriptor {
  for (const thing of packageRecords()) {
    const payload = record(thing.payload);
    if (payload.kind !== 'capability-action-descriptor-record') continue;
    if (payload.id !== 'action:activation-manager.deliver-device-permission') continue;
    return readWorkflowRequestDescriptor(record(payload.workflow));
  }
  throw new DevicePermissionDeliveryError('Device permission delivery descriptor is not configured.');
}

function descriptorFromInput(input: DeliverDevicePermissionInput): WorkflowRequestDescriptor {
  return input.descriptor ? readWorkflowRequestDescriptor(input.descriptor) : descriptorFromPackage();
}

function readRequiredText(value: unknown, label: string) {
  const output = text(value);
  if (!output) throw new DevicePermissionDeliveryError(`${label} is required.`, 400);
  return output;
}

function loopbackCallbackUrl(value: unknown): string {
  const raw = readRequiredText(value, 'callback_url');
  if (raw.length > 1_024) throw new DevicePermissionDeliveryError('callback_url is invalid.', 400);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DevicePermissionDeliveryError('callback_url is invalid.', 400);
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'http:'
    || !url.port
    || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)
    || url.username
    || url.password
  ) throw new DevicePermissionDeliveryError('callback_url must be an explicit local loopback listener.', 400);
  return url.toString();
}

function activationCallbackBody(input: DeliverDevicePermissionInput): Record<string, unknown> {
  const packet = input.packet ?? {};
  const verifierInput = input.verifierInput ?? packet.verifier_input;
  const activationMaterial = input.activationMaterial ?? packet.activation_material;
  if ((verifierInput === undefined) === (activationMaterial === undefined)) {
    throw new DevicePermissionDeliveryError(
      'Exactly one verifier_input or activation_material value is required.',
      400,
    );
  }
  return {
    state: input.state ?? packet.state ?? null,
    ...(verifierInput === undefined ? {} : { verifier_input: verifierInput }),
    ...(activationMaterial === undefined ? {} : { activation_material: activationMaterial }),
  };
}

export function buildDevicePermissionDeliveryWorkflowInput(
  input: DeliverDevicePermissionInput,
): Record<string, unknown> {
  const packet = input.packet ?? {};
  const callbackUrl = loopbackCallbackUrl(input.callbackUrl ?? packet.callback_url);
  const body = new TextEncoder().encode(JSON.stringify(activationCallbackBody(input)));
  return {
    http: {
      authorization: null,
      body: Array.from(body),
      credential_injections: [],
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      timeout_ms: 10_000,
      url: callbackUrl,
    },
  };
}

function readWorkflowReply(payload: Uint8Array): { output?: unknown; completed: boolean } {
  const body = new TextDecoder().decode(payload);
  const parsed = body.trim() ? record(JSON.parse(body)) : {};
  const completion = text(parsed.completion ?? parsed.result ?? parsed.outcome);
  return {
    output: parsed.output,
    completed: completion ? completion === 'completed' : parsed.completed === true,
  };
}

export async function deliverDevicePermission(
  input: DeliverDevicePermissionInput,
): Promise<{ delivered: true; output?: unknown }> {
  const descriptor = descriptorFromInput(input);
  const request = buildOwnerActionWorkflow(descriptor, buildDevicePermissionDeliveryWorkflowInput(input));
  const reply = await sendRequestToBitfieldTarget(request);
  const body = readWorkflowReply(reply.payload);
  if (!body.completed) {
    throw new DevicePermissionDeliveryError('Device permission delivery did not complete.');
  }
  return { delivered: true, output: body.output };
}
