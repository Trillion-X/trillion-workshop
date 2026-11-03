# parts/docs-site/

Turns anyone's docs manifest (site facts, navigation, pages, two colour palettes) into every file a Mintlify docs site is made of. It runs as the Workshop tool `tool:build-docs-site` for every Trillion account; the person's AI saves the files and pushes them to the person's own repository connected to their own Mintlify project.

## Files

| File | Purpose |
|------|---------|
| `part.json` | Lists `do-work/build-docs-site.mjs` as this part's only public file. |
| `do-work/build-docs-site.mjs` | The pure generator: manifest in, `{ files }` or `{ problems }` out. Names no product, page kind or colour. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `buildDocsSite(manifest)` | `{ site: { name, description, url, ... }, navigation: [{ tab, groups: [{ group, pages: [route] }] }], pages: [{ route, title, description, body }], palettes: { light, dark }, roles: { accent, page, accent_strong? }, variable_prefix? } → { files: [{ path, text }], problems: [text] }` | Builds `docs.json`, `theme.css`, `theme.js`, `llms.txt` and `<route>.mdx` for every page in the navigation. |
| `docsSiteProblems(manifest)` | `manifest → [text]` | Every problem with a manifest at once, in plain words (missing field, page listed twice, page with no title, palette missing a role). |

## What it does not do

It does not publish. Creating the Mintlify project and connecting the repository happen once per person in their own Mintlify dashboard; this keeps the tool free of anyone's credentials, so every account can run it.

## Dependencies

**Depends on:** nothing (no file system, no network).
**Depended on by:** `src/engine-tools.mjs` (module `docs-site`, export `buildDocsSite`), the row `tool:build-docs-site` in `records/workshop-engine-tool-records.json`, `test/docs-site.test.mjs`, and Trillion's own docs (Trillion-X/trillion-docs).
