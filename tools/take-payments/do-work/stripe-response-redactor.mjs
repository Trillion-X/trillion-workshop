const SECRET_KEY_RE = /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_]+\b/g;
const WEBHOOK_SECRET_RE = /\bwhsec_[A-Za-z0-9_]+\b/g;

const REDACTED_KEYS = [
  'authorization',
  'api_key',
  'secret',
  'client_secret',
  'webhook_signing_secret',
  'stripe_signature',
  'signature',
];

export function redactStripeResponse(value) {
  if (Array.isArray(value)) return value.map(redactStripeResponse);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        REDACTED_KEYS.some((secretKey) => key.toLowerCase().includes(secretKey))
          ? '[redacted]'
          : redactStripeResponse(entry),
      ]),
    );
  }
  if (typeof value !== 'string') return value;
  return value.replace(SECRET_KEY_RE, '[redacted]').replace(WEBHOOK_SECRET_RE, '[redacted]');
}
