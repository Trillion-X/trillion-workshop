# keep-action-surfaces-complete

The versioned action surface contract from old `src/action-completeness.mjs`, preserved under `read-data/` with caller-owned policy and execution-mode rows. `createActionCompleteness({ policy, modes })` supplies all the original workflow construction, idempotent recipe decoration, inventory and proof validators. Frozen run recipes are never mutated.

The Workshop row runs `do-work/complete-actions.mjs`. Settings arrive only as input rows (`policy`, and `modes` to decorate); the tool reads no records. There is no bundled policy content and no old Worker execution engine. Missing opinion rows fail explicitly.

`ports/action-completeness.json` and `source-baselines/` preserve provenance; `test/` proves action coverage, authorization and recovery evidence, graph refusal, recipe immutability and caller isolation.
