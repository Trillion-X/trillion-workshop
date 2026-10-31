# tools/learn-from-everyones-results/

Learning from everyone's results without any one person's result being readable, even to whoever runs the pool. A person's own store sends one bit about a shared situation ("did it work?") after randomized response, under a random contributor id it keeps to itself. The account that holds the pool keeps those bits as rows of a list and gives one answer from them: how often things worked in situations close in meaning to the asked one, with one vote per contributor, nothing under a minimum number of people, the median across contributor shards, fixed noise and rounded counts. Withdrawal removes every row of one contributor. The math is the old app's `src/pooled-learning.mjs`, unchanged; the rows are records reached through `tools/records-door`.

## Files

| File | Purpose |
|------|---------|
| `read-data/pooled-learning.mjs` | The math, unchanged from the old app: `randomizedResponse`, `debias`, `shardOf`, `seededLaplace`, `aggregateOnRead`, and the choice-point promotion (`armFor`, `promotedArm`). Pure: no disk, no clock, no storage. |
| `read-data/pooled-results.mjs` | The five tools as functions over the records door: `randomizeAResult` (in the person's store), `addPooledSituation`, `addPooledResult`, `withdrawPooledResults`, `howSimilarResultsTurnedOut` (in the pool account). Its header holds the invariants. |
| `read-data/pooled-results.json` | DATA: the two lists the pool account keeps (results and shared situations) and their row types, the longest embedding taken, removals per write, and the words of every refusal., and the bounds of a shared entry |
| `read-data/plain-privacy-pass.mjs` | The plain privacy pass, ported from the plain half of the old app's `src/private-rewrite.mjs`: `findings` (what words for strangers still carry: an address, a handle, a long number, a phone number, an amount of money, a key, the removed mark, a private term, a name inside a sentence), `privateTerms` (a person's own terms from their never-publish phrases, what they gave and the proper names in their texts), `redact`, `redactAll`, `namesIn`. |
| `read-data/plain-privacy-pass.json` | DATA: the patterns with why, the removed mark, the ordinary capitalised words, and the generic dictionaries every shared text is checked against (legal entity words, place names). A person's own words are their records, never here. |
| `tool-rows.json` | The Workshop rows: `tool:randomize-a-result`, `tool:add-a-shared-situation`, `tool:add-a-pooled-result`, `tool:withdraw-pooled-results`, `tool:how-similar-results-turned-out`. |
| `part.json` | `pooled-learning.mjs`, `pooled-results.mjs` and `plain-privacy-pass.mjs` are public, for the decision tools that share a decision and send a result. |
| `test/pooled-learning.test.mjs` | The old app's tests of the math, ported. |
| `test/plain-privacy-pass.test.mjs` | The plain pass on synthetic words: each kind of identifying detail found, general words left alone, names only inside a sentence, a person's own terms. |
| `test/pooled-results.test.mjs` | The rows and the answer with synthetic people: a result takes its situation's meaning, far situations are not counted, no row or contributor is ever returned, one person counts once, the same rows give the same answer, withdrawal, refused rules, a shared situation kept only in general words under a new random id, and the rows' rights. |

## Key Types / Functions

| Function | Signature | Role |
|----------|-----------|------|
| `randomizeAResult` | `({ worked, rules }) -> { worked }` | The one bit that may leave a person's store; the truth with probability e^ε/(1+e^ε). |
| `addPooledSituation` | `({ entry, embedding }, { door }) -> { situation }` | One shared situation, its words checked again by the plain pass with no private terms; a new random id. |
| `findings` | `(value, terms?) -> [words]` | What the plain pass still finds; empty means it passes. With no terms, the always-private words still count. |
| `addPooledResult` | `({ contributor, situation, worked }, { door }) -> { added }` | One row; its embedding is the shared situation's own. |
| `withdrawPooledResults` | `({ contributor }, { door }) -> { removed }` | Every row of one contributor removed. |
| `howSimilarResultsTurnedOut` | `({ embedding, rules }, { door }) -> { enough, people_at_least, worked_share? }` | The only read of the pool. |
| `aggregateOnRead` | `(rows, rules, { question, version }) -> answer` | One vote per contributor, minimum people, shard median, debias, fixed noise, buckets. |

## How privacy holds

1. The clean result never leaves the person's store. Only the randomized bit is sent (ε = ln 3 in the pool's settings), so the pool, and anything that leaks it, holds noise about any one person.
2. Nobody reads the rows. The answer is the only read; it needs the minimum number of distinct people, rounds what it shows, and its noise is fixed by the question and by the rows of the shards that answer it, so asking again cannot average the noise away.
3. A contributor id is random, kept only in the person's own store, and linked to no account; a row holds no account and no shared text.
4. A minority of shards filled with fake people moves the median of shard means little; one person sending many results counts once.
5. Every rule (ε, minimum people, shards, noise, buckets, closeness) is the caller's: the pool's own settings, never a default here.
6. A shared situation's words pass the plain privacy pass twice: on the person's side with their own private terms (`tools/decide-with-a-method` `tool:share-a-decision`, beside a second model's re-identification verdict bound to the exact words), and again here with none, so words that carry an address, a number, an amount, a key or a name never enter the pool whatever a sender checked.

## Dependencies

**Depends on:** `tools/records-door` (the door client and `run-an-export.mjs`), `tools/content-identity` (BLAKE3, for shards, noise seeds and the question's identity; it loads `@noble/hashes`, which the rows pack too), Node 24 in the tool container.

**Depended on by:** `tool-rows.json`, the tests here, and the decision tools that share a decision (the plain privacy pass) and send a result about it.
