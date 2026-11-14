import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import {
  RUN_OUTCOME_REQUEST_SCHEMA,
  type RunOutcomeReceipt,
  type RunOutcomeRequest,
} from './run-outcome-owner.ts';

type RequestSender = (request: {
  readonly target: string;
  readonly payload: Readonly<Record<string, unknown>>;
}) => Promise<unknown>;

export async function commitWalkthroughCompletion(
  request: Omit<RunOutcomeRequest, 'schema'>,
  send: RequestSender = sendRequestToBitfieldTarget as RequestSender,
): Promise<RunOutcomeReceipt> {
  const reply = await send({
    target: 'guided-overlay.run-outcome',
    payload: { schema: RUN_OUTCOME_REQUEST_SCHEMA, ...request },
  }) as { payload?: Uint8Array };
  if (!(reply.payload instanceof Uint8Array)) return reply as unknown as RunOutcomeReceipt;
  return JSON.parse(new TextDecoder().decode(reply.payload)) as RunOutcomeReceipt;
}
