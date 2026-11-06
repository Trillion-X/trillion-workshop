# tools/rank-library-formats-against-concepts/

Lays every format a person has collected beside every idea they could film, so judges can rank the best fits, and keeps the ranking. The tool has two steps:

- `catalog` prints every candidate format and every concept as tab-separated lines. The judges read the whole catalog for each concept and write that concept's best three to five formats, with the reason each fits.
- `apply` checks the judged file against the catalog. It refuses a format key the catalog does not hold, and it refuses a concept nobody judged. It then writes three things into the person's titles file: the options, the palette of formats in use, and an about note.

The ranking is a reading by judges, not a model score. A cross-encoder scores topic, not form, and it put product tutorials on top for personal concepts.

This was moved from a film's tools folder (`rank_formats.py`, see `ports/rank-formats.json`).
- Its readers, its record and its refusals are the old code, line for line.
- The paths are now the request's.
- What belonged to one person or film is now their settings: a row of their `list:settings` (`record:setting:rank-library-formats-against-concepts~<scope_kind>~<scope_id>`), read through `tools/settings`.

On the film's in-git library, concept files and titles file, the `catalog` output and the `apply` file are byte-for-byte the old tool's.

## Files

| File | Purpose |
|------|---------|
| `do-work/rank_formats.py` | The command. It reads the request on standard input (or `--request FILE`) and runs step `catalog` or `apply`. `--base FOLDER` is where relative paths are read and where the titles file is written. It prints its lines, then `{"result": {...}}` as its last line. |
| `ports/rank-formats.json` | The port contract: the film tool's code, copied byte for byte first, then adapted. |
| `tool-rows.json` | `tool:rank-library-formats-against-concepts`, a `computer` row with `change-a-folder`. It runs under `tools/settings`' `run-with-settings.mjs`, so `settings_record` is read through the run's records door. It has two sample runs. |
| `part.json` | Nothing here is imported by other code. |
| `test/test_rank_formats.py` | Covers the readers, both steps, the refusals, request paths in the granted folder, and settings (including a retired row), on a made-up library, bank, concept files, package CSV and judged files. |
| `test/rank-library-formats-against-concepts.test.mjs` | Checks the row and runs those tests. |

## The request

| Key | What it holds |
|---|---|
| `step` | `catalog` or `apply`. |
| `library` | The library folder: its `INDEX.md` (rows under the `## All items` heading) and `formats/<folder>/FORMAT.md`. |
| `bank` | A title-template bank markdown file. The templates that `form_templates` lists become candidates. |
| `concepts` | `{files: [markdown files]}`. Each `## <ID> ...` heading is a concept, and its table rows are its beats. |
| `package` | An optional CSV of package concepts (`id`, `domain`, `viewer_gets`, `proof_needed`). The rows whose ids are in `package_ids` are added. |
| `titles`, `judged` | For `apply`: the titles file to rewrite, and the judged files, laid over each other in order. |
| `settings_record`, `settings` | The person's `list:settings` row for this folder, and settings for this run laid over it. |

The settings (defaults are in `do-work/rank_formats.py`):

| Setting | Holds | Default |
|---|---|---|
| `form_templates` | `{bank id: [name, form]}` | none |
| `stable_keys` | format folder → the key other work already uses | none |
| `own_formats` | the person's own formats, as candidate rows | none |
| `package_ids` | which package rows to add as concepts | none |
| `skip_concepts` | concepts to leave out | none |
| `empty_options` | concepts written with no options | none |
| `form_template_path` | template for a bank template's path | `{bank_name} template {id}` |
| `default_material` | the material wording when a judged option names none | generic wording |
| `about_template` | the about note's text | generic text |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `configure` | `(request, base)` | Sets what the readers read from the request and the settings. |
| `candidates` | `() => [row]` | Each analysed item in the index's all-items table, the bank's form templates and the person's own formats. It skips rows that only point at another write-up or that name no folder. |
| `concepts` | `() => {id: concept}` | Headings, beats, how many beats are local or in cloud storage, and the package rows. |
| `catalog`, `apply` | the two steps | `apply` writes `format_options`, `format_palette` and `format_ranking_about`, and leaves the rest of the titles file as it was. |

## Dependencies

**Depends on:** Python 3.10 or later and its standard library. It also needs `tools/settings` (`read-data/settings.py`, `do-work/run-with-settings.mjs`) and `tools/records-door`, which its row packs.

**Depended on by:** `tool-rows.json`.

## Invariants

- Nothing in the code names a person, a film or a place on a disk. The person's templates, keys, own formats, package ids, skipped concepts and prose arrive as settings.
- `apply` refuses before it writes: an unknown format key or an unjudged concept leaves the titles file untouched.
- Judges rank. Nothing here scores a pair with a model.
