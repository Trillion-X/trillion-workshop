// tools/evaluate-progress/read-data/score-instrument.ts
// Turn a questionnaire's responses into scored facts: reverse-keyed items are reflected on the response scale and each item is filed under its subscale. A questionnaire that is not marked validated, or is banned, is refused.


export type ResponseScale = { min: number; max: number };

export type ScorableInstrument = {
  id: string;
  measureFamily?: string;
  responseFactKind: string;
  validated: boolean;
  banned?: boolean;
  bannedReason?: string;
  responseScale: ResponseScale;
  subscales: Array<{ id: string; label?: string; items: string[] }>;
  reverseItems?: string[];
  items?: Array<{ id: string; subscale: string; text?: string }>;
};

export type InstrumentResponse = { item: string; response: number };

export type InstrumentResponseFact = {
  id: string;
  kind: string;
  instrument: string;
  subscale: string | null;
  item: string;
  response: number;
  scored_value: number;
  reversed: boolean;
};

export function reflect(scale: ResponseScale, response: number): number {
  return scale.min + scale.max - response;
}

export function assertScorable(instrument: ScorableInstrument): void {
  if (instrument.banned) {
    throw new Error(`instrument '${instrument.id}' is a banned construct: ${instrument.bannedReason ?? "not validated"}`);
  }
  if (!instrument.validated) {
    throw new Error(`instrument '${instrument.id}' is not validated — refusing to score (evidence-based only)`);
  }
  if (typeof instrument.responseFactKind !== "string" || instrument.responseFactKind === "") {
    throw new Error(`instrument '${instrument.id}' has no responseFactKind: say what kind the scored facts carry`);
  }
}

export function scoreInstrumentResponses(
  instrument: ScorableInstrument,
  responses: readonly InstrumentResponse[]
): InstrumentResponseFact[] {
  assertScorable(instrument);
  const factKind = instrument.responseFactKind;
  const reverse = new Set(instrument.reverseItems ?? []);
  const subscaleOf = new Map<string, string>();
  for (const it of instrument.items ?? []) subscaleOf.set(it.id, it.subscale);
  for (const s of instrument.subscales) for (const it of s.items) if (!subscaleOf.has(it)) subscaleOf.set(it, s.id);

  return responses.map((r, i) => {
    const reversed = reverse.has(r.item);
    return {
      id: `${instrument.id}:${r.item}:${i}`,
      kind: factKind,
      instrument: instrument.id,
      subscale: subscaleOf.get(r.item) ?? null,
      item: r.item,
      response: r.response,
      scored_value: reversed ? reflect(instrument.responseScale, r.response) : r.response,
      reversed,
    };
  });
}
