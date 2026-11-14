# Content Analytics Show

The React surface is rendering-only over the serializable model from
`read-data/content-analytics-model.ts`.

It does not declare package record classes, interpret payload field names, or
write owner records. Actions route through `do-work/content-analytics-actions.ts`
and that module builds owner-action requests from descriptor data.

## Empty And Sparse State

The browser surface uses the entry-scoped package data hook because
`contentMediaEvidence` is a package-declared custom input. With no evidence
rows, it renders the compact `Results are waiting for a finished post` starter
and keeps the source/detail panels visible. It must not render a giant `No data`
hero or crash when the descriptor is present at the identity-text package
record address.
