# CS-043 Cross Surface Execution Contract

Browser/Desktop/React and iOS JSCore surfaces consume the same evidence
projection records and invoke the same owner action descriptors.

Allowed:

- read `evidence-projection-record` rows;
- invoke `action:stripe-payment-provider.start-checkout` by descriptor id;
- receive public handoff material from a redacted projection;
- display invocation, receipt, projection, and provider object proof refs only as
  non-raw labels supplied by the projection.

Forbidden:

- direct Stripe secret access;
- provider session creation in UI;
- device-specific provider backend logic;
- local translation from provider states to access/account/CRM outcomes;
- raw provider payload display.

The shared proof ids are `capability-invocation:<idempotency_key>`,
`execution-receipt:<idempotency_key>`, and
`evidence-projection:capability-invocation:<idempotency_key>`.
