# Run a TypeScript program with no build step

`tool:run-a-typescript-program-with-no-build` proves that a tool's program can be TypeScript. The engine's pinned Node
(v26.13.0, `pinned-files.json` `programs.node`) strips TypeScript types by default, so the row starts `node do-work/echo.ts`
and nothing is built or kept.

## What it does

It reads `{"words": "..."}` on standard input and answers `{"result": {"words", "node", "types_stripped"}}`: the words as they
came, the Node version that ran it, and whether that Node strips types itself.

## Rules for a TypeScript program

- Erasable syntax only: type annotations, interfaces and `type` aliases. No `enum`, no `namespace`, no constructor parameter
  properties: Node refuses them without a build.
- A relative import names the `.ts` file it reads (`import { x } from './x.ts'`).
- Tests are `tests/*.test.ts`, run by `node --test`.

## Files

| File | What |
|---|---|
| `tool-rows.json` | the card: a container run of `node do-work/echo.ts`, no network |
| `do-work/echo.ts` | the program |
| `tests/echo.test.ts` | starts the program as the row does and checks its answer |

## Check it

```
node --test tools/run-a-typescript-program-with-no-build/tests/
```
