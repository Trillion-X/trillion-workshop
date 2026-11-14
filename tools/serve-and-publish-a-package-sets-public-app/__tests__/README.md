# hosted-public-app Tests

`hosted-public-app-backend.test.ts` proves the logic/backend rebase:

- metadata is read from descriptor data;
- field, view, rule, relationship, and action materializer descriptors exist;
- the publish workflow stays on `compute.process` with explicit `on_result`
  edges;
- the owner-action bridge materializes a workflow envelope from descriptor data;
- invalid descriptor-input validation fails before transport invocation;
- the generic projection fold works for this package and an unrelated fixture.

Run from the `bitfield-packages` repository root:

```bash
npx vitest run --config ./vitest.config.ts packages/hosted-public-app/__tests__/hosted-public-app-backend.test.ts
```
