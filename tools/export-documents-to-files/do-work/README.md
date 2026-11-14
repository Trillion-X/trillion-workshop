# Structured File Output Work

Owns byte creation and browser downloads for structured file output requests.
Domain packages translate their own records into this generic request shape;
they do not own PDF, Word (DOCX), spreadsheet, or text file rendering. DOCX is
emitted as OOXML by the existing byte renderer from generic headings,
paragraphs, lists, and tables.

The separate `export-node-tree-to-file` action also emits DOCX using Python's
standard-library ZIP and XML modules. Its compute environment needs Python 3,
which the action already invokes, and no `python-docx` installation.

That action renders PDF through the bundled ReportLab runtime. The active PDF
projection rule selects the TrueType font filename; the renderer embeds that
font, checks glyph coverage before writing, preserves searchable Unicode, and
uses ReportLab's flow layout for pagination and repeating table headers. A
missing font or unsupported character fails the export instead of substituting
characters.

The generic export action mounts its caller job and current projection-rule
rows as JSON files in the admitted process workspace and invokes the renderer
with `--job-file` and `--rules-rows-file`. Direct callers may also keep using
the legacy `--job-json` and `--rules-rows-json` options. File inputs are read as
bounded, strict UTF-8 JSON from regular non-symlink files, so a large structured
document does not have to fit in the process argument vector.

For a read-only projection inspection, add `--project-only`. The CLI uses the
same bounded job/rule reads, rule selection, and generic tree projector, then
prints a `structured-file-export-projection` JSON object (schema version 1)
with the selected format, title, and ordered sections to stdout. It exits before
format rendering, font checks, destination handling, payload hashing, or any
result/export file writes; the requested result path is ignored in this mode.

The native DOCX format may set `body_style`, `title_style`, `table_style`, and
spacing fields on each configured heading style. Styles accept `font_family`,
`size_half_points`, `bold`, `space_before_twips`, `space_after_twips`, and
`line_spacing` (240 means one line), and optional boolean `widow_control`.
Setting `widow_control` to true asks the Word layout engine to keep at least two
lines together at a page boundary; false explicitly disables that behavior.
Omitting it leaves pagination defaults unchanged. A configured table style keeps cell spacing
independent of body paragraphs. Omitted style settings preserve the existing
defaults. Style identities are unique and malformed values fail before export.
`table_header_rows` repeats that many leading rows on table continuation pages;
it defaults to zero and cannot exceed a table's row count. Optional
`space_after_table_twips` sets space before the first body paragraph after a
table, while following headings keep their own style spacing.
`table_allow_row_split` defaults to true. Setting it to false keeps an individual
row together when it can fit on a page; rows taller than a page still depend on
the Word layout engine.

Browser downloads are a handoff contract: once this package has created the
file bytes and attempted a browser handoff, UI callers treat the output as
requested even if the shell reports an object URL, synthetic click, or cleanup
quirk after bytes exist.
