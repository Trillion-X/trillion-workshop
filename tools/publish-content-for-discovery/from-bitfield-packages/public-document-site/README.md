# public-document-site

## Purpose

`public-document-site` supplies package data for the addressed-record
publication pipeline. It owns selector/rule/action configuration, a read-only
document review surface, and workflow records that write byte-addressed
publication artifact pointers.

The active backend primitive is:

```text
addressed records -> publication-view data -> owner action/process output -> byte-addressed artifact records -> maintained projections
```

The old package-shaped backend family is dead here. There is no
`PublicSiteFactSet`, no package-owned HTTP server, no direct route-record body
bytes, and no executable `published` status gate.

## Records

The package declares a generic publication-view record at
`package::public-document-site::publication-view::default`. That record names
the source scopes, selectors, visibility rules, ordering rule, route key rule,
artifact pointer field names, and maintained projection address.

Document field names such as title, slug, blocks, source refs, schema labels, or
state labels are Society data selected by that record. They are not backend
classes, enums, or shared-code branches. Site config records carry base path,
domain, entity data, crawler policy, `llms.txt` policy, and an opaque IndexNow
key reference as package data.

## Surface

The `show/` entry reads `public-documents`, `public-site-config`, and
`public-document-publication-view`. The read model consumes selector/rule/order
data. When no visibility rule is supplied, all valid rows stay visible; the
reader does not hide rows by comparing a package status string.

## Workflows

`render-on-publish` writes generic `publication-artifact`,
`publication-route`, and `publication-proof` records. Artifact records point to
`content_byte_address` plus integrity metadata; representation bodies travel
through the engine byte path, not through route records.

`public-document-site.prepare-current-document` reads the current Documents
revision, sources and composition DATA and obtains separate factual and writing
reviews. It returns a candidate requiring rendered review; it cannot publish.

`content-distribution/do-work/publish-current-document.mjs` is the native
publication entry. It accepts document and destination references, records the
existing publication intent, and calls the fixed `hosted-public-app` owner.
That owner renders the candidate using the current serving image, reviews real
desktop and mobile screenshots, rechecks the inputs, replaces exactly one
Article in the existing archive, and verifies its public readback. The same
archive supplies normal and recovery Article reads. Missing or rejected reviews
prevent replacement. Native Docker/browser execution is not advertised as an
in-engine JavaScript target. No caller-supplied page or approval is accepted.

`resolve-route-to-html` is a route-record to artifact-pointer lookup for a
separate public product entry or shell transport. This package does not open
sockets, define ports, own credentials, or serve HTTP.

## Proof

Focused backend proof:

```bash
cd /path/to/bitfield-packages
npx vitest run --config ./vitest.config.ts packages/public-document-site/read-data/__tests__/read-public-document-site.test.ts packages/public-document-site/tests/public-document-site-boundary.test.ts
```
