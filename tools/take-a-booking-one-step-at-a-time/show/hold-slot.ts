// tools/take-a-booking-one-step-at-a-time/show/hold-slot.ts
//
// PURPOSE
//   The step of a booking that needs the server's fact: choosing a time, which may have been taken since the times were read. The
//   screen shows the time chosen with its button pending and asks the step tool to hold it; this says what happened in words the
//   screen draws: the time is held, or it is not and why (the tool's own words), and the times still open without the one refused.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A refused time is never kept as chosen: the answer is `held: false` with the tool's words, or the page's `failed` words when
//      the failure has none.
//   2. The times offered after a refusal are the times offered before, less the refused one, in the same order.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
export type Slot = { startIso: string; endIso: string };
export type Held = { held: true } | { held: false; message: string };

export async function holdSlot(hold: () => Promise<unknown>, failed: string): Promise<Held> {
  try {
    await hold();
    return { held: true };
  } catch (caught) {
    return { held: false, message: caught instanceof Error && caught.message ? caught.message : failed };
  }
}

export const withoutSlot = (slots: Slot[], taken: Slot): Slot[] => slots.filter(slot => slot.startIso !== taken.startIso);
