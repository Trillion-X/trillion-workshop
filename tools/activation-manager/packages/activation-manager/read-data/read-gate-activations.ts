import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import {
  decodeCapabilityStateRecords,
  record,
  text,
  type PackageThing,
} from './capability-state-records';
import { foldCapabilityState, type CapabilityStateProjection } from './fold-capability-state';

type CapabilityStateReadDescriptor = {
  target: string;
  payload: Record<string, unknown>;
};

type CapabilityStateReadInput = {
  subjectRef: string;
  capabilityRef?: string;
  descriptor?: CapabilityStateReadDescriptor;
  things?: PackageThing[];
};

function decodeTargetReply<TResponse>(payload: Uint8Array): TResponse {
  const body = new TextDecoder().decode(payload);
  return (body.trim() ? JSON.parse(body) : {}) as TResponse;
}

function readDescriptor(value: unknown): CapabilityStateReadDescriptor | null {
  const row = record(value);
  const target = text(row.target);
  if (!target) return null;
  return {
    target,
    payload: record(row.payload),
  };
}

function packageThingsFromReply(value: unknown): PackageThing[] {
  const body = record(value);
  const things = Array.isArray(body.things) ? body.things : Array.isArray(body.records) ? body.records : [];
  return things.map((entry) => ({ payload: record(entry).payload ?? entry }));
}

export async function readGateActivations(
  input: string | CapabilityStateReadInput,
): Promise<CapabilityStateProjection> {
  const request = typeof input === 'string' ? { subjectRef: input } : input;
  const descriptor = readDescriptor(request.descriptor);
  if (!descriptor) {
    return foldCapabilityState(decodeCapabilityStateRecords(request.things ?? []));
  }
  const reply = await sendRequestToBitfieldTarget({
    target: descriptor.target,
    payload: {
      ...descriptor.payload,
      subject_ref: request.subjectRef,
      capability_ref: request.capabilityRef,
    },
  });
  return foldCapabilityState(decodeCapabilityStateRecords(packageThingsFromReply(decodeTargetReply(reply.payload))));
}
