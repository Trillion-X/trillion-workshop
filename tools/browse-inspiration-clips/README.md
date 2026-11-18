# tools/browse-inspiration-clips

The Inspiration screen's data and its drawing. `inspiration.json` is DATA: the layouts, the sources (where each kind of card comes from in the person's own rows, its card fields, what opening it does, which clips can start an edit), the sections, the actions and the words. `show/inspiration-mount.tsx` and `web/src/workspace/inspiration-screen.tsx` draw the rows the screen is given.

Sorting the sources into named rows of cards is no longer a tool. It is the recipe `workflow:browse-inspiration-clips` (`tools/workflows/recipes/browse-inspiration-clips.json`): the person's AI reads `inspiration.json`, reads each source from the person's own store, and answers the rows. The code that did it (`browse-inspiration.mjs`, `card-sections.mjs`, `inspiration.mjs`), its kit and its tool row were removed in the landing commit, because they read no store and only sorted the sources handed in.

`from-an-older-version/` keeps the older test bytes, unchanged.
