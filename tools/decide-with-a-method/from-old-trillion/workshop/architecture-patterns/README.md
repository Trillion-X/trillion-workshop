# Production architecture patterns in the Workshop

The original 1000x reference remains unchanged at
`<checkout>/.ai-orchestra/reference/1000x-plan-architecture-reference.md`.
The account-owned Workshop tool `tool:1000x-architecture-patterns` keeps a copy of
that reference with `main.py` and exposes its 105 numbered patterns separately.
`index` lists the patterns, a task phrase searches them, and `#N` returns the
complete original section. The tool is published to all Trillion accounts and
its name and job appear in the anonymous public catalog.

`workflow:1000x-pattern-guided-coding` is published to all accounts. It searches
the catalog, asks the running AI to inspect the actual code and adapt selected
invariants, and requires a real check of the result. The Rust snippets, old
thresholds, and historical security choices are examples, never automatic
instructions for another codebase. Publication is through Trillion's saved tool
and workflow DATA; neither depends on the retired Bitfield runtime.

The current source files are `main.py`, `descriptor.json`, and `workflow.json`.
To test extraction locally, set `ARCHITECTURE_REFERENCE_PATH` to the preserved
reference and run `python3 main.py '#105'`. The live Workshop copy was saved
with the unmodified reference text as `reference.md`. Updating the catalog
means saving that same source with the current parser and running its sample
check before publication.

This avoids rereading thousands of lines on architecture-sensitive coding
tasks. It does not make MCP calls execute in nanoseconds: one live pattern
lookup took 10.8 seconds through the container tool on 2026-09-29. The
workflow is for work where re-deriving the architecture would cost more than
that lookup. The separate connector and transport latency remains.
