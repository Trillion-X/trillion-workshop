# Structured File Output Read Data

Defines format descriptors and the generic request shape used by any package
that wants rows or structured sections turned into downloadable files. DOCX is
generated as OOXML with the existing ZIP byte writer and adds no host Python or
third-party runtime dependency.

`StructuredFileOutputSection.blocks` may carry ordered `heading`, `paragraph`,
`list`, and `table` blocks. When supplied, `blocks` is the section content;
the legacy `lines` and `rows` fields remain supported for existing callers.
