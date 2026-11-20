# do-work

This package stores workflow-definition records in `things-to-store-and-run.json`.
The workflows are declarative package data for the addressed-record publication
pipeline.

`render-on-publish` writes generic route, artifact, and proof records. The
artifact record carries `content_byte_address`, `media_type`, and
`integrity_hash`; it does not embed representation bodies in route/current-state
records.

`resolve-route-to-html` reads a route record, then reads the linked artifact
record, then returns an artifact pointer for a separate public entry or shell
transport. It is not a package-owned HTTP server.

`prepare-current-document.mjs` accepts only `document_ref`. It uses the actual
runtime sender to read current Documents, composition, destination, citation
mapping and policy records, invoke factual and writing reviews, and recheck all
inputs after review. Client approval fields are rejected. Its result remains
`render-review-required` and cannot select a public page. The hosted publication
owner must render and review those exact bytes before changing the served
archive.

`read-published-documents.mjs` reads the publication view as data. The view
row names the selectors, the visibility rules, the order, the route key (with
its address prefixes) and the artifact field names. `readPublishedModel` returns
the visible documents in that order with their route; `readArtifactRecord` names
the artifact fields the view gives. Pure, and nothing calls it live: no route
serves it.
