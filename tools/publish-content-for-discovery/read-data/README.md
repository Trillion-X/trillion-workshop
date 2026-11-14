# read-data

This folder translates package inputs into the document-site surface model.

The reader consumes:

- `public-documents`
- `public-site-config`
- `public-document-publication-view`

Visibility, ordering, identity, route key, and state selection are data in the
publication-view record. The reader does not compare a package status literal to
decide what exists on screen.

Run the focused reader proof from the package repo root:

```bash
npx vitest run --config ./vitest.config.ts packages/public-document-site/read-data/__tests__/read-public-document-site.test.ts
```
