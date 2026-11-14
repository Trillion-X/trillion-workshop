# Content Analytics Read Data

This folder owns the pure translation from package records plus descriptor data
to a serializable surface model.

`content-analytics-model.ts` has zero React, Runtime Kit, workflow, process, or
browser imports. It only follows open field, view, rule, and action descriptors.
Package nouns stay in descriptor records and payload paths, not in control flow.

`post-performance-attribution.ts` joins published status rows to actual provider
observations by status reference or remote post identity. It joins captured
traffic only when `utm_content` exactly matches the publish intent or remote post
identity uniquely among accepted posts, then follows visitor and project IDs to
captured conversion facts. Ambiguous UTM tokens and conversions without matching
project evidence are left unlinked. Missing values remain absent; this projection
does not invent metric zeroes.

Empty values now serialize as waiting/result-source language so every renderer
can show a compact source-state panel without a product-breaking `No data`
headline.
