// packages/ui/show/format-money.ts
//
// Generic money display primitive (L069). A minor-unit amount + an ISO currency
// code become one localized currency string. Pure, universal, zero domain
// vocabulary — checkout, public-sales-page, and any surface that shows a price
// reuse THIS one function instead of hand-rolling `Intl.NumberFormat`. Whole
// amounts render with no decimals ("$180"); fractional amounts render two
// ("$0.50"). A non-finite amount returns "" so callers can fall back cleanly.
export function formatMoneyCents(amountCents: number, currency: string = 'usd'): string {
  if (!Number.isFinite(amountCents)) return '';
  return new Intl.NumberFormat('en-US', {
    currency: (currency || 'usd').toUpperCase(),
    maximumFractionDigits: amountCents % 100 === 0 ? 0 : 2,
    style: 'currency',
  }).format(amountCents / 100);
}
