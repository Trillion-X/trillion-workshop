# Package Store Reviews Browser Surface Guardrails

Browser and desktop surfaces consume the package-store-reviews reader contracts.
They do not read source records, calculate score summaries, decide visibility,
or duplicate owner-action rules.

Required consumption path:

- Read `package::package-store-reviews::reader-output::package-page` or another
  declared reader output.
- Render the finished `summary`, `items`, `filters`, and `actions` sections.
- Invoke action descriptors by id through the package owner path.
- Keep layout and controls in shared `ui` and `screen-look` primitives.

Proof command:

```bash
cd dev/bitfield-packages
npx vitest run --config ./vitest.config.ts packages/package-store-reviews/show/package-store-reviews-consumer-contract.test.tsx
```
