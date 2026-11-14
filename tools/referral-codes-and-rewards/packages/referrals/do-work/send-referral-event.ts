// packages/referrals/do-work/send-referral-event.ts
//
// Make a referral lifecycle event and keep it in the person's own records. The retired sender signed the event through
// the Bitfield runtime's signed event author and admitted it through its signed event authority (README.md of the tool
// lists each call); here the event is what the tool gives back (tool:make-a-referral-code, tool:apply-a-referral-code)
// and keeping it is writing it as a row of the referral event list (read-data/referral-event-list.json).

import { writeRecords } from '#workspace/records-door';
import { newRunKey, runWorkshopTool } from '#workspace/workshop-tool-api';
import { makeReferralCode as makeReadableCode } from '../../../read-data/referral-codes.mjs';
import eventList from '../../../read-data/referral-event-list.json' with { type: 'json' };
import { readReferralEvents, type ReferralEvent } from './read-portal-referrals';

export interface ReferralEventInput {
  accountId: string;
  eventType: 'referral_code_created' | 'referral_code_applied';
  eventId: string;
  occurredAt: string;
  referralCode: string;
  requestId?: string;
}

type CodeTarget = { on: string; value: string };

let codeTarget: CodeTarget | null = null;

/** The sale attribute and value a code made here points at: the screen's input names it, since a code earns nothing without one. */
export function setReferralCodeTarget(target: CodeTarget | null) {
  codeTarget = target;
}

async function toolEvents(tool: string, input: Record<string, unknown>, requestId: string | undefined): Promise<ReferralEvent[]> {
  const answer = await runWorkshopTool(tool, input, requestId ?? newRunKey('referral')) as { result?: { event?: ReferralEvent; events?: ReferralEvent[] } };
  const events = answer.result?.events ?? (answer.result?.event ? [answer.result.event] : []);
  if (events.length === 0) throw new Error(`${tool} gave back no event to keep`);
  return events;
}

/** Keeps each event as a row; the row's id is made from the event, so keeping the same event twice is one row. */
async function keepEvents(events: ReferralEvent[]) {
  await writeRecords(events.map(event => ({
    id: `${eventList.id_prefix}${String(event.kind)}:${String(event.subject)}:${String(event.material?.occurred_at)}:${String(event.material?.account_id ?? event.material?.referral_code)}`,
    type: eventList.type,
    value: event as Record<string, unknown>,
  })));
}

export async function sendReferralEvent<TResponse>(input: ReferralEventInput): Promise<TResponse> {
  const events = input.eventType === 'referral_code_created'
    ? await (async () => {
      if (!codeTarget) throw new Error('this screen was given no target for a new code');
      return toolEvents('tool:make-a-referral-code', { referrer: input.accountId, code: input.referralCode, target: codeTarget, occurred_at: input.occurredAt }, input.requestId);
    })()
    : await toolEvents('tool:apply-a-referral-code', { account: input.accountId, code: input.referralCode, events: await readReferralEvents(), occurred_at: input.occurredAt }, input.requestId);
  await keepEvents(events);
  return { events } as TResponse;
}

export function makeReferralCode(prefix = 'REF') {
  return makeReadableCode({ prefix, randomBytes: count => crypto.getRandomValues(new Uint8Array(count)) });
}
