# Measure search visibility

`tool:measure-search-visibility` measures how one site shows up in three places, and gives back the rows and SQL that record it:

- **Google organic results.** For each search term, the site's position in the top 100, or a plain "not ranking" when it is not there. A results page with no readable domains is "not measured", never a zero.
- **Keyword volume.** One batch call for all the terms. A term the provider has no number for stays null.
- **AI answers.** For each question, on each chosen engine (ChatGPT, Gemini, Google AI Mode, Perplexity): whether the answer names the business (`name_pattern`) and whether it cites one of the site's addresses.

It can also take Search Console rows the person has already read. It does not call Google itself.

## What it writes

It writes nothing. It answers the rows, and an SQL plan: the table statements and one insert per row, for `public.search_visibility_measures`. The person's AI runs that plan with `tool:run-sql-in-my-database`, against the database named as `store`. Every row has `site`, `phase` (before, after or check), `kept_by`, and `raw.client` when a client is given, so one client's rows can be moved or filtered later.

## Run it

```
node tools/measure-search-visibility/do-work/measure.mjs REQUEST.json
```

`REQUEST.json` is the input in the row: `site`, `store`, `keywords`, and optionally `questions`, `engines`, `location`, `client`, `phase`, `kept_by`, `name_pattern`, `top3_keywords`, `search_console`. The last line is `{"result": ...}` or `{"error": ...}`.

A live run calls `treg` on this computer, so it needs the treg command signed in, and each keyword, the volume batch and each question on each engine is one paid call. A request with `"replay": "sample-replies.json"` reads made-up answers from `data/` instead and needs no network: that is the sample run the row proves.

## Where things are

- `do-work/measure.mjs`: the program. Node's standard library only.
- `data/endpoints.json`: the treg endpoints, the body each takes, and the reader of each answer. Changing a route is a DATA edit here.
- `data/table.json`: the table statements, the insert, and its column order.
- `data/sample-replies.json`: made-up answers for the sample run and the tests.
- `kits/measure-search-visibility.json`: the kit (start here, instructions, worked example).
- `test/measure-search-visibility.test.mjs`: tests on made-up data, including the SQL run on PGlite.

## Limits

- The organic route takes no location. A local search term carries the city in its own words, and the row records the city.
- Google's AI Overview is not read by the organic route; the Google AI Mode engine is the one measured here.
- Named is measured only when a `name_pattern` is given.
- A result set that is short (fewer than the depth asked) is measured as far as it goes; the row says how many came back.
