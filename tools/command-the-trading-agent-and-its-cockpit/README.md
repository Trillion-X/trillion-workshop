# tools/command-the-trading-agent-and-its-cockpit/

The Investment Command screen: the trading cockpit that shows an agent's live status, its watchlist as a table, its cycle (a hero record and one row per evaluated signal, with the reason a signal was held in one sentence) and the controls that send the person's command to the trading agent. It is built on the visual-database generic primitive: which metrics, which watchlist columns and which statuses show are descriptor data (`things-to-store-and-run.json`, read by `read-data/investment-command-surface.ts`), not code. Moved byte for byte from bitfield-packages `packages/investment-command`.

## Files

| File | Purpose |
|------|---------|
| `do-work/run-investment-command-action.ts` | Local action invoker for the Trading Center recipe. Cross-package work |
| `read-data/README.md` | The package's own note, moved as written. |
| `read-data/cockpit-board.ts` | PURPOSE |
| `read-data/investment-command-surface.ts` | Trading Center is a cockpit over package-owned inputs. It never |
| `read-data/read-trading-agent-cycle.ts` | PURPOSE |
| `read-data/read-trading-workspace-layout-state.ts` | The package's code, moved as written. |
| `show/InvestmentCommandPanel.tsx` | PURPOSE |
| `show/README.md` | The package's own note, moved as written. |
| `show/mount-investment-command.tsx` | The package's code, moved as written. |
| `things-to-store-and-run.json` | Data the package carried as written. |
| `moved-from.json` | Where each file came from: source path and commit in bitfield-packages, the identity of its source bytes and of its bytes here, the call rows applied, the held tests and the files that still call the retired runtime. |
| `part.json` | Nothing here is imported by this tree; the folder is a part another tree imports. |
| `README.md` | This file |

## Still on the retired runtime

These files are the original bytes, with import paths changed to this tree. They call the retired package runtime or a package path this tree does not hold, so no tool row opens them until each call is swapped for the records door.

- `do-work/run-investment-command-action.ts`: retired package runtime
- `read-data/read-trading-agent-cycle.ts`: a package path of the old app that is not in this tree
- `show/InvestmentCommandPanel.tsx`: a package path of the old app that is not in this tree, retired package runtime

## Dependencies

**Depends on:** `tools/keep-lists-of-rows` (the visual-database read model), the shared ui parts of the web client, Node 24.

**Depended on by:** nothing yet; a tool row and its screen wiring come once the held calls are swapped.
