// src/screen-day.mjs
//
// A day as the account screens' facts say it (Oct 3, 2026), in UTC; null for anything that is not a date-time or date text.
export const dayWords = iso => (typeof iso === 'string' && iso.length >= 10 ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : null);
