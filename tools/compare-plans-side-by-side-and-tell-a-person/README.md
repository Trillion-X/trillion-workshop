# tools/compare-plans-side-by-side-and-tell-a-person/

Compare plans side by side and tell a person what a feature needs when their plan lacks it.

Moved here byte for byte from Trillion-X/trillion by `tools/move-code-between-trees`; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. Trillion-X/trillion imports these files from this package. The folder keeps the source tree's own paths under it, so the files import each other as they did.

## Internal platform refusal producer

`read-data/platform-plan-refusal.mjs` composes the original PersonStore `runsInEveryPlan`, `withheld` and `upgradeOfferFor` methods with trusted account-owner suppliers. The complete source span at `b6ae0eb:src/person-store.mjs:11485–11510` was preserved as an inert baseline in commit `058dd1655f68895ee3cdd624297cdc57bb176b4c` before adaptation. `ports/platform-plan-refusal.json` records this source-first lineage.

The owner supplies the current platform capabilities and limits, decision allowance, account fact, tool/placement catalogue, existing feature predicate, refusal words and optional upgrade arm. A refusal retains the word supplier's output, `upgrade_needed` and the feature. POST `/tools/run` is exempt only when the named tool has at least one placement and every placement explicitly includes every plan. Source failures stay errors; they do not become a free plan or an exemption. A null result answers only the plan question, separate from authentication, reach and operation execution.

The catalogue supplier follows the original `src/stored-checks.mjs:46–61` at `b6ae0eb`, which decodes the tools against the shipped placements. Its decoder is retained at `tools/ai-tool-catalog/read-data/read-ai-tool-catalog.ts:658–673` (receipt source `1e886c3f68828439c545f34bbef0e415055a800f:tools/ai-tool-catalog/read-data/read-ai-tool-catalog.ts`). A runnable tool must have at least one admitted placement; mixed admitted and unresolved references can remain valid and are non-exempt. A supplied runnable tool with no admitted placement contradicts that contract and stays unavailable. A truly unknown tool in a complete decoded catalogue receives no placement exemption, matching the original method.

The synthetic source tests exercise the actual predicate and the retained producer, including opposing policy and placement cases. They supply synthetic catalogue DATA to the predicate's existing shared offer-row dependency. Run them with `node --test tools/compare-plans-side-by-side-and-tell-a-person/test/*.test.mjs` from the repository root.

This is an internal source composition. The production catalogue import, the canonical native account-policy and operation-entitlement binding, the original service/publisher exemptions, MCP serialization and public API admission retain their separate qualification boundaries. The preserved Apps assertions are unchanged.
