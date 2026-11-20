// Pure policy of a site's own Worker, ported from the old Worker host (tag the pre-retirement Worker host tag,
// src/site-worker-installation.mjs:20-22 and 151-176, src/site-worker-source.mjs:78-92). Each function reads its inputs and
// nothing else, so an owner that runs a site on a computer can use them without any host. Not wired into a row or a route yet.

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// A route whose original app is linked keeps the original backend authoritative: the copied Worker may not run for it.
export const siteUsesOriginalBackend = route => object(route?.linked_routes) && Object.keys(route.linked_routes).length > 0;

const CRON_BOUNDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

// A five-field cron text (minute hour day-of-month month day-of-week), each field a list of spans with optional steps.
export function validCron(cron) {
  const fields = cron.split(' ');
  return fields.length === 5 && fields.every((field, index) => field.split(',').every(part => {
    if (!/^(?:\*|\d{1,2}(?:-\d{1,2})?)(?:\/\d{1,2})?$/.test(part)) return false;
    const [span, stepText] = part.split('/');
    const [first, last] = span === '*' ? CRON_BOUNDS[index] : span.includes('-') ? span.split('-').map(Number) : [Number(span), Number(span)];
    return (!stepText || Number(stepText) > 0) && first >= CRON_BOUNDS[index][0] && last <= CRON_BOUNDS[index][1] && first <= last;
  }));
}

// Whether a cron text matches the UTC minute of `date`. Day-of-month and day-of-week combine as cron does: either matches
// when both are restricted, both must match when one is `*`.
export function cronMatches(cron, date) {
  const values = [date.getUTCMinutes(), date.getUTCHours(), date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCDay()];
  const fields = cron.split(' ');
  const matches = fields.map((field, index) => field.split(',').some(part => {
    const [span, stepText] = part.split('/');
    const step = stepText ? Number(stepText) : 1;
    if (step < 1) return false;
    const [first, last] = span === '*' ? CRON_BOUNDS[index] : span.includes('-') ? span.split('-').map(Number) : [Number(span), Number(span)];
    return first >= CRON_BOUNDS[index][0] && last <= CRON_BOUNDS[index][1] && first <= values[index] && values[index] <= last &&
      (values[index] - first) % step === 0;
  }));
  const dayMatches = fields[2] === '*' || fields[4] === '*' ? matches[2] && matches[4] : matches[2] || matches[4];
  return matches[0] && matches[1] && dayMatches && matches[3];
}

// The permissions a Worker runs with: each declared field takes the source's value, and any change to a granted value
// (or to receive_email) leaves the Worker offline until it is enabled again. `existing` is the saved permissions or null.
export function pinnedWorkerPermissions(existing, declared = {}) {
  const fields = ['outbound_hosts', 'ai_models', 'crons', 'email_senders', 'receive_email'];
  const defaults = { outbound_hosts: [], ai_models: [], crons: [], email_senders: [], receive_email: false };
  const permissionSet = (key, values) => [...new Set(values.map(value =>
    key === 'email_senders' ? `${value.email}\0${value.name}` : value))].sort();
  const changed = Object.entries(declared).some(([key, value]) => key === 'receive_email'
    ? value !== (existing?.[key] ?? defaults[key])
    : JSON.stringify(permissionSet(key, value)) !==
      JSON.stringify(permissionSet(key, existing?.[key] ?? defaults[key])));
  return {
    ...Object.fromEntries(fields.map(key => [key, declared[key] ?? existing?.[key] ?? defaults[key]])),
    enabled: changed ? false : existing?.enabled ?? false,
  };
}
