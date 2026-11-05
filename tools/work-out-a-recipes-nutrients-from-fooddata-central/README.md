# tools/work-out-a-recipes-nutrients-from-fooddata-central/

Works out the nutrients in a person's recipe from their USDA FoodData Central downloads: 33 nutrients for the whole batch and per 100 g of mix, each ingredient's share, and % of the adult 19-30 Dietary Reference Intake (men and women) with a flag. One JSON request in, one JSON answer out; it reads only the CSVs it is given and makes no calls.

The recipe is the person's data, never this code's. It comes in the request. Kept for later, the person's recipe lives as a row `record:setting:work-out-a-recipes-nutrients-from-fooddata-central~piece~<piece-id>` in `list:settings`, whose value is this tool's request (without `datasets`, which name folders on one computer), so their AI reads it, adds the datasets and runs the row.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | `tool:work-out-a-recipes-nutrients-from-fooddata-central`: a container row (argv, the request on standard input, `result_selector` `"$"`), with a sample run on a made-up smoothie. |
| `part.json` | Nothing here is imported by other code. |
| `do-work/work_out_recipe_nutrients.py` | The command. Reads the request on standard input or from `--request <file>`, reads each dataset (a folder or the CSV texts), and prints the answer as its last line: `{ profile, recipe, summary_lines, written }` or `{ error }` (exit 1). With `write_to` it also writes `<id>.profile.json` and `<id>.recipe.json` (indent 1). |
| `read-data/fooddata_central.py` | The FoodData Central reader and the reference data, kept from the source: `NUTS` (33 nutrients: key, label, unit, FDC nutrient ids in fallback order), `DRI` (adult 19-30, male and female), `DOSE_MAX` (sodium, a limit). `load(base)` reads a download folder (an empty amount is skipped; a later row for the same food and nutrient wins), `load_texts(texts)` the same from CSV texts, `per100(src, fdc)` (first nutrient id a food has wins), `portion_g(src, fdc, word)` (the first portion whose modifier and description contain the word, case-insensitive, as gram_weight / amount). |
| `read-data/recipe_profile.py` | `work_out(request, tables, built)`: grams (as given, or count x one portion), label scaling, totals, rounding, flags, caveats, the profile and the recipe. Pure. |
| `ports/recipe-nutrients-reading.json`, `ports/recipe-nutrients-profile.json` | The port contracts: the source file's reading part (lines 1-100) and its summing part (lines 116-152), each byte-copied here first and then adapted. The source's recipe lines (101-115, 153-197) are the person's data and did not move as code. |
| `test/test_recipe_nutrients.py` | 12 tests on two made-up datasets: fallback ids, empty amounts, last row wins, portions, label scaling, rounding, every flag, unknowns in a main ingredient, caveats, the recipe's kept words, the printed table, refusals, the command on stdin, `--request`, folders and `write_to`. |
| `test/work-out-a-recipes-nutrients.test.mjs` | Checks the row, runs its sample the way the container runner does, and runs the Python tests; skips, saying why, without python3. |

## The request

```json
{
  "id": "made-up-smoothie", "title": "Made-up smoothie",
  "datasets": { "sr_legacy": { "dir": "<SR Legacy CSV folder>" }, "foundation": { "dir": "<Foundation CSV folder>" } },
  "ingredients": [
    { "id": "drink", "name": "Soy drink", "amount": "1 cup", "fdc_id": "1750337", "dataset": "foundation",
      "portion": { "dataset": "sr_legacy", "fdc_id": "175215", "unit_contains": "cup", "count": 1 }, "base": true },
    { "id": "curd", "name": "Firm tofu", "amount": "one block", "fdc_id": "172475", "dataset": "sr_legacy", "grams": 400,
      "scale_to_label": { "nutrient": "protein", "amount": 40 }, "modelling_note": "scaled by {scale:.3f} to the pack's protein" },
    { "id": "sweetener", "name": "Sweetener", "amount": "to taste" }
  ],
  "nutrient_caveats": { "calcium": "depends on the coagulant" },
  "cross_check": { "their_count": { "kcal": 500 } },
  "recipe_notes": { "method": { "steps": ["Blend.", "Freeze."] } },
  "write_to": "<a folder>"
}
```

A dataset is `{ "dir": ... }` on the person's computer, or the CSV texts themselves (`food_nutrient` and `food_portion` needed, `nutrient` and `food` optional) where no folder is reachable. An ingredient without `fdc_id` is listed in the recipe and counted as nothing. `base: true` marks a main ingredient: a nutrient it has no value for is flagged `unknown_lower_bound_only` with a caveat, not called a gap. `built` stamps the answer (default now); `basis`, `yield_note` (with `{mix_g:.0f}`), `cross_check` and `recipe_notes` are kept as given.

## How to run it

```
python3 -I tools/work-out-a-recipes-nutrients-from-fooddata-central/do-work/work_out_recipe_nutrients.py --request recipe.json
python3 -I tools/work-out-a-recipes-nutrients-from-fooddata-central/do-work/work_out_recipe_nutrients.py < recipe.json
node --test tools/work-out-a-recipes-nutrients-from-fooddata-central/test/*.test.mjs
```

## Moved from

`tools/tofu_ice_cream_profile.py` in Trillion-X/source-repo-a (commit 5a9ba39), a script with one recipe written into its code and three folder arguments. Every behaviour moved one to one: the nutrient list and fallback ids, the DRIs, empty amounts skipped, portions as gram_weight / amount of the first matching row, scaling one ingredient to a label nutrient, the rounding (contributions 4 places, per batch and per 100 g 3, % DRI 1, mass and cross-check 1), the flags and their order (sodium a limit; a main ingredient's unknown overrides; a named caveat last), the two output files and the printed table. What changed, and why:

- The recipe (ingredients, grams, portions, FDC ids, label numbers, notes, evidence) is the request, not code; "main ingredient" is `base: true` instead of two ids named in code; the calcium caveat is `nutrient_caveats`.
- Three field names no longer name one recipe: `per_tub` is `per_batch`, `per_ingredient_contribution_per_tub` is `per_ingredient_contribution_per_batch`, `tofu_scale_factor` is `scale_factors: { <ingredient id>: ... }`.
- The portion word is lower-cased too (the old code lower-cased only the portion text); `food.csv` and `nutrient.csv` are optional; a missing food, portion or dataset is refused in words instead of a traceback.
- The last printed line names each ingredient's id instead of fixed names.

On a made-up FoodData-Central-shaped fixture set the old script and this tool gave equal profiles (after the three renames), equal recipes and an equal printed nutrient table.

## Dependencies

**Depends on:** Python 3 standard library only; the person's FoodData Central CSV downloads (public domain), given in the request.

**Depended on by:** `tool-rows.json`. Nothing imports this folder.
