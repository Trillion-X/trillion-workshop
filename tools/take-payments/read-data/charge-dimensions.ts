import type {
  CommercialChargeDimension,
  CommercialPriceOption,
} from '../../funnels-and-offers/read-data/read-offers.ts';
import { curveAmountCents } from './unit-price-curve.ts';

export type CheckoutChargeDimensionInput = {
  dimensionId: string;
  units?: number;
  scopedUnits?: Array<{ scopeId: string; units: number }>;
};

export type CheckoutChargeDimensionBreakdown = {
  amountCents: bigint;
  dimensionId: string;
  inputKind: 'scalar' | 'per_scope';
  units?: number;
  scopedUnits?: Array<{ amountCents: bigint; scopeId: string; units: number }>;
};

export type CheckoutChargeDimensionEvaluation = {
  breakdown: CheckoutChargeDimensionBreakdown[];
  totalAmountCents: bigint;
};

const MAX_SCOPED_ITEMS = 10_000;

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return Number(value);
}

function amountForUnits(dimension: CommercialChargeDimension, units: number): bigint {
  const dimensionPrice: CommercialPriceOption = {
    amount_cents: 0,
    id: `dimension:${dimension.id}`,
    included_units: dimension.included_units,
    label: dimension.label,
    unit_price_curve: dimension.unit_price_curve,
  };
  return curveAmountCents(dimensionPrice, units);
}

function inputByDimension(
  dimensions: readonly CommercialChargeDimension[],
  inputs: readonly CheckoutChargeDimensionInput[],
) {
  const known = new Set(dimensions.map((dimension) => dimension.id));
  const byId = new Map<string, CheckoutChargeDimensionInput>();
  for (const input of inputs) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('Each charge dimension input must be an object.');
    }
    if (!known.has(input.dimensionId)) {
      throw new Error(`Unknown charge dimension ${input.dimensionId}.`);
    }
    if (byId.has(input.dimensionId)) {
      throw new Error(`Duplicate charge dimension input ${input.dimensionId}.`);
    }
    byId.set(input.dimensionId, input);
  }
  return byId;
}

/**
 * Additive N-dimensional price evaluation. Numbers, dimension kinds, scope
 * relationships, included units, and curves are all offer DATA. The evaluator
 * contains no app or product vocabulary and leaves legacy unitCount pricing
 * untouched when charge_dimensions is absent.
 */
export function evaluateChargeDimensions(
  price: CommercialPriceOption,
  rawInputs: readonly CheckoutChargeDimensionInput[] | undefined,
): CheckoutChargeDimensionEvaluation | undefined {
  const dimensions = price.charge_dimensions ?? [];
  const inputs = rawInputs ?? [];
  if (!Array.isArray(inputs) || inputs.length > 32) {
    throw new Error('Charge dimension inputs must be an array of at most 32 items.');
  }
  if (dimensions.length === 0) {
    if (inputs.length > 0) throw new Error('This price does not declare charge dimensions.');
    return undefined;
  }
  const byId = inputByDimension(dimensions, inputs);
  const scalarCounts = new Map<string, number>();
  const breakdown: CheckoutChargeDimensionBreakdown[] = [];

  for (const dimension of dimensions) {
    if (dimension.input_kind !== 'scalar') continue;
    const input = byId.get(dimension.id);
    if (input?.scopedUnits != null) {
      throw new Error(`Scalar charge dimension ${dimension.id} cannot receive scopedUnits.`);
    }
    const units = input?.units == null
      ? dimension.included_units
      : nonNegativeSafeInteger(input.units, `chargeDimensions.${dimension.id}.units`);
    scalarCounts.set(dimension.id, units);
    breakdown.push({
      amountCents: amountForUnits(dimension, units),
      dimensionId: dimension.id,
      inputKind: 'scalar',
      units,
    });
  }

  let scopedItemCount = 0;
  for (const dimension of dimensions) {
    if (dimension.input_kind !== 'per_scope') continue;
    const input = byId.get(dimension.id);
    if (input?.units != null) {
      throw new Error(`Per-scope charge dimension ${dimension.id} cannot receive units.`);
    }
    const scopedUnits = input?.scopedUnits ?? [];
    if (!Array.isArray(scopedUnits)) {
      throw new Error(`Charge dimension ${dimension.id} scopedUnits must be an array.`);
    }
    scopedItemCount += scopedUnits.length;
    if (scopedItemCount > MAX_SCOPED_ITEMS) {
      throw new Error(`Charge dimensions exceed the ${MAX_SCOPED_ITEMS} scoped-item limit.`);
    }
    const scopeCardinality = scalarCounts.get(dimension.scope_dimension_id ?? '');
    if (scopeCardinality == null || scopedUnits.length > scopeCardinality) {
      throw new Error(`Charge dimension ${dimension.id} has more scoped items than ${dimension.scope_dimension_id}.`);
    }
    const seenScopes = new Set<string>();
    const rows = scopedUnits.map((row, index) => {
      const scopeId = typeof row?.scopeId === 'string' ? row.scopeId.trim() : '';
      if (!scopeId || scopeId.length > 128 || seenScopes.has(scopeId)) {
        throw new Error(`chargeDimensions.${dimension.id}.scopedUnits[${index}] requires a unique scopeId up to 128 characters.`);
      }
      seenScopes.add(scopeId);
      const units = nonNegativeSafeInteger(
        row.units,
        `chargeDimensions.${dimension.id}.scopedUnits.${scopeId}.units`,
      );
      return { amountCents: amountForUnits(dimension, units), scopeId, units };
    }).sort((left, right) => left.scopeId.localeCompare(right.scopeId));
    breakdown.push({
      amountCents: rows.reduce((total, row) => total + row.amountCents, 0n),
      dimensionId: dimension.id,
      inputKind: 'per_scope',
      scopedUnits: rows,
    });
  }

  return {
    breakdown,
    totalAmountCents: BigInt(Math.max(0, Math.trunc(price.amount_cents ?? 0)))
      + breakdown.reduce((total, row) => total + row.amountCents, 0n),
  };
}
