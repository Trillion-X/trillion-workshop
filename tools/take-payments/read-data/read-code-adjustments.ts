export type CheckoutCodeAdjustmentDiscount = {
  amount_cents?: number;
  kind: 'amount_cents' | 'percent';
  percent?: number;
};

export type CheckoutCodeAdjustmentScope = {
  access_refs: string[];
  offer_ids: string[];
  price_option_ids: string[];
};

export type CheckoutCodeAdjustment = {
  adjustment: CheckoutCodeAdjustmentDiscount;
  code: string;
  id: string;
  label: string;
  result_label?: string;
  scope: CheckoutCodeAdjustmentScope;
  sort_order: number;
  state: 'active' | 'inactive';
  summary?: string;
};

export type AppliedCheckoutCodeAdjustment = {
  code: string;
  discountCents: bigint;
  id: string;
  label: string;
  resultLabel: string;
};

export type CheckoutCodeAdjustmentProjection = unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(readString).filter((item): item is string => Boolean(item)) : [];
}

function readNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function normalizeCheckoutCodeValue(value: unknown) {
  return readString(value)?.toUpperCase().replace(/\s+/g, '') ?? '';
}

function recordList(projection: CheckoutCodeAdjustmentProjection): unknown[] {
  if (Array.isArray(projection)) return projection;
  if (isRecord(projection) && Array.isArray(projection.records)) return projection.records;
  return [];
}

function readScope(value: unknown): CheckoutCodeAdjustmentScope {
  const source = isRecord(value) ? value : {};
  return {
    access_refs: readStringArray(source.access_refs),
    offer_ids: readStringArray(source.offer_ids),
    price_option_ids: readStringArray(source.price_option_ids),
  };
}

function readAdjustment(value: unknown): CheckoutCodeAdjustmentDiscount | null {
  if (!isRecord(value)) return null;
  const kind = readString(value.kind);
  if (kind === 'percent') {
    const percent = Math.max(0, Math.min(100, readNumber(value.percent, 0)));
    return { kind, percent };
  }
  if (kind === 'amount_cents') {
    const amount = Math.max(0, Math.trunc(readNumber(value.amount_cents, 0)));
    return { amount_cents: amount, kind };
  }
  return null;
}

export function readCheckoutCodeAdjustments(
  projection: CheckoutCodeAdjustmentProjection,
): CheckoutCodeAdjustment[] {
  return recordList(projection)
    .flatMap((record) => {
      if (!isRecord(record) || record.kind !== 'checkout-code-adjustment') return [];
      const id = readString(record.id);
      const label = readString(record.label);
      const code = normalizeCheckoutCodeValue(record.code);
      const adjustment = readAdjustment(record.adjustment);
      if (!id || !label || !code || !adjustment) return [];
      return [{
        adjustment,
        code,
        id,
        label,
        result_label: readString(record.result_label),
        scope: readScope(record.applies_to),
        sort_order: readNumber(record.sort_order, 0),
        state: readString(record.state) === 'inactive' ? 'inactive' : 'active',
        summary: readString(record.summary),
      }];
    })
    .sort((left, right) => left.sort_order - right.sort_order || left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
}

export function findCheckoutCodeAdjustment(
  adjustments: readonly CheckoutCodeAdjustment[],
  code: unknown,
) {
  const normalized = normalizeCheckoutCodeValue(code);
  if (!normalized) return undefined;
  return adjustments.find((adjustment) => adjustment.state === 'active' && adjustment.code === normalized);
}

