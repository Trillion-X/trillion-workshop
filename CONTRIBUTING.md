# Contributing a tool

Thank you for making a tool. Every merged tool is offered to every Trillion user's AI, so a tool here must do exactly what its row says, every time.

## The rules a tool follows

1. **One folder, everything in it.** Code, `tool-rows.json`, `README.md` and tests live in `tools/<your-tool>/`. A tool may import only from its own folder and from Node or Python's standard library, unless its row packs the module it needs.
2. **One JSON request in, one JSON answer out.** The command reads the request on standard input (or in `argv`, if its row says so) and prints its answer as the last line. Nothing is kept between runs.
3. **The job is in plain words.** `job` is what a person would ask for ("work out my unit economics"), never the tool's internal name. Trillion finds tools by their job.
4. **Say what it takes and gives back.** `input_schema` and `output_schema` are JSON Schemas; every answer is checked against `output_schema`.
5. **Prove it with a sample run.** `verify` holds a sample input and text the output must contain. Trillion runs it before offering the tool.
6. **No secrets, no personal data.** Never put a key, token, password, email address or a real person's details in code, rows, tests or examples. A tool that needs an account takes it from the person at run time.
7. **Name its licence class.** `licence_class` is one of the ids in `licence-classes.json`, and `placements` must be places that class allows.
8. **No internet unless needed.** Set `"internet": true` in `invoke` only when the job is reading the web; such tools refuse private and local addresses.
9. **Refusals say what to do.** An error tells the caller what was wrong and how to fix the request.

## Checks

`npm test` runs every tool's tests and `test/every-tool-row.test.mjs`, which reads the rows the way Trillion does. A pull request must pass it.

## Adding a repository from GitHub

To offer someone else's open-source project, add a row to `tools/tools-from-github/sources.json` and run `node tools/tools-from-github/index-github-tools.mjs`. It reads the licence from GitHub; a repository whose licence no class lists is refused.

## Licence

By contributing you agree that your contribution is licensed under the Apache License 2.0.
