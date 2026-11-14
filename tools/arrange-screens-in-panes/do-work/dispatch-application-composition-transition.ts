import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import {
  decodeApplicationContributionOwnerDescriptors,
  planApplicationCompositionTransition,
  type ApplicationContributionOwnerDescriptor,
  type ApplicationCompositionTransitionOperation,
} from '../read-data/application-composition';
import { insideTargetReplyEnvelope } from '../read-data/target-reply-envelope';

type Plain = Record<string, unknown>;

export type ApplicationContributionSender = (
  request: { target: string; payload: unknown },
) => Promise<unknown>;

function plain(value: unknown): value is Plain {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function things(value: unknown, path: string): Plain[] {
  if (!Array.isArray(value) || !value.every(plain)) throw new Error(`${path} must be an array of things`);
  return value;
}

function ownerThings(
  rawReply: unknown,
  operation: ApplicationCompositionTransitionOperation & { kind: 'owner-contribution' },
  descriptor: ApplicationContributionOwnerDescriptor,
): Plain[] {
  // The sender returns `{ payload: Uint8Array }`, so an owner's reply arrives WRAPPED. Reading
  // `reply.write_set` off the envelope finds nothing and blames the OWNER for returning no write
  // set, which is the same defect that made the composition apply blame the engine for an invalid
  // readback. The symptom points away from the cause in both, so the unwrap has one owner now.
  const decoded = insideTargetReplyEnvelope(rawReply);
  const reply = decoded instanceof Uint8Array
    ? JSON.parse(new TextDecoder().decode(decoded)) as unknown
    : decoded;
  if (!plain(reply) || !plain(reply.write_set)) throw new Error(`${operation.target_ref} returned no write_set`);
  const upserts = things(reply.write_set.upserts, `${operation.target_ref}.write_set.upserts`);
  const retractions = things(reply.write_set.retractions, `${operation.target_ref}.write_set.retractions`);
  if (operation.phase === 'retract' && upserts.length > 0) {
    throw new Error(`${operation.target_ref} returned upserts during retract phase`);
  }
  if (operation.phase === 'upsert' && retractions.length > 0) {
    throw new Error(`${operation.target_ref} returned retractions during upsert phase`);
  }
  const selected = operation.phase === 'retract' ? retractions : upserts;
  for (const thing of selected) {
    if (typeof thing.type !== 'string' || !descriptor.write_authority.thing_types.includes(thing.type)) {
      throw new Error(`${operation.target_ref} returned an unauthorized thing type`);
    }
    if (typeof thing.address !== 'string') {
      throw new Error(`${operation.target_ref} returned a thing without an address`);
    }
    const addressAllowed = descriptor.write_authority.exact_addresses.includes(thing.address)
      || descriptor.write_authority.address_prefixes.some((prefix) => thing.address.startsWith(prefix));
    if (!addressAllowed) throw new Error(`${operation.target_ref} returned an address outside owner authority`);
  }
  return selected;
}

export async function dispatchApplicationCompositionTransition(
  input: unknown,
  send: ApplicationContributionSender = sendRequestToBitfieldTarget as ApplicationContributionSender,
) {
  if (!plain(input)) throw new Error('application composition dispatch input must be an object');
  if (!Object.hasOwn(input, 'previous_composition')) throw new Error('previous_composition is required');
  if (!Object.hasOwn(input, 'next_composition')) throw new Error('next_composition is required');
  if (!plain(input.projector_template)) throw new Error('projector_template must be an object');
  if (!Array.isArray(input.previous_owner_descriptors)) throw new Error('previous_owner_descriptors must be an array');
  if (!Array.isArray(input.next_owner_descriptors)) throw new Error('next_owner_descriptors must be an array');
  const previousDescriptors = decodeApplicationContributionOwnerDescriptors(input.previous_owner_descriptors);
  const nextDescriptors = decodeApplicationContributionOwnerDescriptors(input.next_owner_descriptors);
  const previousDescriptorsByOwner = new Map(previousDescriptors.map((descriptor) => (
    [descriptor.owner_ref, descriptor]
  )));
  const nextDescriptorsByOwner = new Map(nextDescriptors.map((descriptor) => (
    [descriptor.owner_ref, descriptor]
  )));
  const transition = planApplicationCompositionTransition(
    input.previous_composition ?? undefined,
    input.next_composition ?? undefined,
    input.projector_template,
    previousDescriptors,
    nextDescriptors,
  );
  const orderedThings: Array<{
    phase: 'retract' | 'upsert';
    source: 'local' | 'owner';
    target_ref?: string;
    lifecycle?: { composition_id: string; contribution_id: string; state_epoch: number };
    thing: Plain;
  }> = [];
  for (const operation of transition.ordered_operations) {
    if (operation.kind === 'local-thing') {
      orderedThings.push({ phase: operation.phase, source: 'local', thing: operation.thing });
      continue;
    }
    const descriptor = (operation.phase === 'retract' ? previousDescriptorsByOwner : nextDescriptorsByOwner)
      .get(operation.contribution.owner_ref);
    if (!descriptor || descriptor.target_ref !== operation.target_ref) {
      throw new Error(`no matching owner descriptor for ${operation.contribution.owner_ref}`);
    }
    const reply = await send({ target: operation.target_ref, payload: operation.contribution });
    for (const thing of ownerThings(reply, operation, descriptor)) {
      orderedThings.push({
        phase: operation.phase,
        source: 'owner',
        target_ref: operation.target_ref,
        lifecycle: {
          composition_id: operation.contribution.composition_id,
          contribution_id: operation.contribution.contribution_id,
          state_epoch: operation.contribution.state_epoch,
        },
        thing,
      });
    }
  }
  return {
    schema: 'bitfield.application-composition-dispatch/owner-authorized-write-set',
    ...(transition.previous_composition_id
      ? { previous_composition_id: transition.previous_composition_id }
      : {}),
    ...(transition.next_composition_id ? { next_composition_id: transition.next_composition_id } : {}),
    ordered_things: orderedThings,
  };
}

export function dispatchApplicationCompositionTransitionTarget(input: unknown, _context?: unknown) {
  return dispatchApplicationCompositionTransition(input);
}
