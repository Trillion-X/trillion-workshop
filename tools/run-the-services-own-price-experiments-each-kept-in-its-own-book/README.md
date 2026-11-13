# tools/run-the-services-own-price-experiments-each-kept-in-its-own-book/

Run the service's own price experiments, each kept in its own book and read by what each published.

This folder has no row yet. Its old Trillion files are in `from-old-trillion/`: the bytes of tag `old-trillion-before-worker-retire`, under their old paths. `from-old-trillion/README.md` says which load here and which are held until what they import is here. Wiring them into a row is adapting them, in a commit that names `moved-from.json`.

## Files

| File | Purpose |
|------|---------|
| `web/src/price-tests-screen.mjs` | `priceTestsAnswer`: the Price tests screen's record set, one row per price of each experiment with its share, who paid and the money in dollars, the chance each price is best, and the steps from seeing a price to paying. Moved byte for byte from the web client (`moved-from.json`). |
| `web/src/price-tests-screen.json` | The screen's words and its layout, as DATA. |
| `web/src/price-experiments.mjs` | Experiments as records an account keeps, and the one way any experiment is served, measured and settled (`experimentResults`, `chanceBest`). |
| `web/src/price-experiments.json` | The experiment kinds and their words, as DATA. |
| `web/src/kept-reads.mjs` | A read made on nearly every request, kept for a few minutes in the Worker's memory and the edge cache (`keptRead`, `notedWithin`, `forget`). |
| `web/src/shipped-defaults.mjs` | Defaults that ship with a deploy and changes that stay with the person: the shipped value of an id is read unless the person changed it, and only the change is kept. |
| `moved-from.json` | The receipt of the move: each moved file's source path and commit and the identity of its bytes there and here. |
