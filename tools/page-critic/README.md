# tools/page-critic

Judges a public page against the saved craft rules at every width they name, and keeps a picture of each width with every finding boxed and numbered.

## Files

| File | Purpose |
|------|---------|
| `part.json` | What other parts and tools may use from this part. |
| `do-work/critique-a-page.mjs` | Opens the page in a headless browser at each width (first once more asking for reduced motion when `reduced_motion_hidden` is a rule), scrolls it once so lazy pictures and frames load, measures it in the page (and again inside each embedded frame, of any origin, for the rules that say `in_frames`), watches embedded live demos for up to `wait_seconds`, forces each control's hover look through DevTools, asks each link once, boxes every finding and photographs the whole page; prints one JSON line. |
| `do-work/measure-rendered-frame.mjs` | The rendered frame check (F-1117), injected into the page by `measure-page-craft.mjs`: `screen_side_margins`, `lopsided_section`, `blank_stretch`, `no_first_screen_title`, `untitled_section`, `left_edge_crowding`. |
| `do-work/measure-page-rules.mjs` | One-line rendered-page rules (F-1149), injected the same way: `tab_order_positive`, `tab_order_backwards`, `heading_skip`, `heading_h1_count`, `page_title`, `page_lang`, `page_description`, `page_viewport`. |
| `do-work/measure-reduced-motion.mjs` | The reduced-motion second pass (F-1119): `firstScreenText` (run in the page in both passes) and `reducedMotionFindings` (compares them). |
| `tool-rows.json` | The Workshop row Trillion reads for this folder: `tool:critique-a-public-page`, which packs `do-work`, `read-data` and `tools/headless-browser`'s `devtools.mjs` and `quiet-switches.json`. |
| `test/` | The critic run against planted local pages (Playwright's Chromium, `test-helpers/chromium.mjs`). |
| `read-data/page-craft-rules.json` | The craft rules as DATA: the widths, each rule's words and thresholds, and the selectors each rule reads. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| command | `node do-work/critique-a-page.mjs --url <page> --out <folder> [--fresh-within-days N] [--rules <file>] [--browser <path>]` | One page, every width. |
| output | `{ url, findings_count, findings: [{ rule, width, says, text?, selector?, rect?, picture }], widths: [{ id, picture, findings }] }` | What was found, and where the marked pictures are under `--out`. |
| rule row | `{ id, says, widths?, ...thresholds }` | One craft rule; `id` picks its measurement, `says` is what a person reads. |
| `MEASURES` | `{ [rule id]: rule => [{ values, element }] }` (run inside the page) | `control_name` (browser-computed name from Chromium's accessibility tree for DATA-selected controls), heading_measure, body_width, eyebrow (short text immediately before a heading and under 60% of its size; case and letter spacing do not exempt it), `repeated_supporting_text` (exact heading repetitions, compact caption fragments adjacent to headings, and DATA-configured production/evidence commentary; preserves accessibility-linked text, status, controls, and sentence-shaped teaching prose), edge_padding, overflow_outside_container (a field, image, table or line reaching past its container or the browser edge, checked down to 240px), broken_anchor, card_cannot_open, stale, endless_scroll; test_data (placeholder words, edition hashes, long hex ids, example.com or proof+ addresses, a "real product screenshots" line, in visible text and alt text), tiny_images (a content picture or clip under a share of its space, a screenshot shrunk so its text is unreadable, or a picture stretched past its own size), duplicate_cards (siblings titled the same once hashes are taken away), stale_demo (looping clips that do not load or have no length); broken_link and no_hover are measured from outside the page, and so is the demo half of stale_demo (`watchDemos`: a frame whose address matches `demo_url_patterns` that cannot be reached, answers 4xx/5xx, shows an error phrase or alert, or is still empty after `wait_seconds`). |

`measurement_templates.rendered_label_size` supplies an optional rule definition for a caller-selected SVG teaching-label scope. The existing `rules` array is the public page critic's automatically executed policy at every configured width; it cannot hold an unconfigured selector/minimum without turning a lesson-specific bound into global policy. A consumer instantiates the template with `selector` and positive finite `min_height_px`, then passes it to the same `pageCraftMeasures` engine. There is one measurement implementation, in `measure-rendered-label-size.mjs`; this adds no second verifier or decision registry.

The result retains `rendered_labels` for readable as well as too-small labels. It measures individual SVG character heights perpendicular to their screen-transformed baseline, rather than treating a rotated or multiline union box or sideways shear as readable type height. Hidden ancestors are excluded; unavailable geometry is a finding. This is a configured size check, separate from containment, clipping, contrast, glyph shape or comprehension. A consumer selects its own diagram parts and keeps its own bound; the shared template has no universal minimum or default label selection.

### Rendered frame, reduced motion, Tab order, headings and metadata

Every row below keeps its words (`says`, `says_by_kind`), thresholds and selectors in `page-craft-rules.json`; each says which item it comes from in `from`.

| Rule | Widths | Fires when |
|------|--------|------------|
| `screen_side_margins` | 390, 1280 | On the first screen or the whole page, the drawn content's left or right margin is under `min_px`, or the two differ by more than `max_difference_px` (full-bleed boxes over `full_bleed_fraction` of the width are left out). |
| `lopsided_section` | 390, 1280 | A section (`selectors.frame_sections`) at least `min_section_px` wide whose drawn lines fill under `max_content_fraction` of it and sit off-centre by more than `max_imbalance` of its width. |
| `blank_stretch` | 390, 1280 | A vertical run of the page taller than `max_screens` screens with no text, picture, control or background picture. |
| `no_first_screen_title` | 390, 1280 | The first screen has no `selectors.frame_titles` heading and no text of `min_title_px` or larger. |
| `untitled_section` | 390, 1280 | A section with at least `min_words` words and no visible `selectors.frame_section_titles` heading. |
| `left_edge_crowding` | 390, 1280 | At least `min_count` text blocks start within `within_px` of the left edge while under `max_right_share` as many come that near the right. |
| `edge_padding` (existing) | 390, 1280 | Text touching the browser's edge: F-1117's "edge text" is this rule, not a new one. |
| `reduced_motion_hidden` | 390, 1280 | The page is opened again with `prefers-reduced-motion: reduce` emulated (DevTools `Emulation.setEmulatedMedia`) and read after `settle_ms`; first-screen text (`selectors.motion_text`) seen in the ordinary pass is still see-through (under `min_opacity`), visibility hidden, not displayed, off the screen, clipped to under `min_shown_fraction`, or gone. The finding names the text and the reason from `reasons`. |
| `control_name` (existing) | every width | Controls with no accessible name: F-1149's accessible-name rule is this one, not a new one. |
| `tab_order_positive` | 1280 | A tab stop (`selectors.tab_stops`) has a tabindex above 0. |
| `tab_order_backwards` | 390, 1280 | In Tab order (positive tabindex first, then the page's order) the next stop is more than `max_jump_up_px` above the one before. |
| `heading_skip` | 1280 | A heading (`selectors.heading_levels`) is more than one level below the heading before it. |
| `heading_h1_count` | 1280 | No `selectors.top_headings`, or more than `most`. |
| `page_title`, `page_lang`, `page_description`, `page_viewport` | 1280 | `<title>` shorter than `min_chars`; no `<html lang>`; meta description shorter than `min_chars`; no viewport meta matching `content_pattern`. |

`test/rendered-frame.test.mjs`, `test/reduced-motion-pass.test.mjs` and `test/page-rules-names-tab-headings-metadata.test.mjs` plant a page that makes each rule fire and a clean page that makes none fire.

## Dependencies

**Depends on:** `tools/headless-browser` (`devtools.mjs`, a Chromium spoken to over DevTools, `quiet-switches.json`).

**Depended on by:** `tool:critique-a-public-page` (`tool-rows.json`), and any check that imports `do-work/measure-page-craft.mjs` (`part.json`).

## Invariants

- Every threshold, selector and width is DATA; adding a rule's measurement is one `MEASURES` entry picked by the rule's id.
- `repeated_supporting_text` finds exact normalized heading repetitions, short unfinished caption fragments beside headings and configured production/evidence commentary. It protects labels, controls, live status, alerts and text referenced by accessibility attributes; complete sentence-shaped teaching prose remains allowed. It does not edit page content.
- The page is only read: nothing is clicked, typed or sent.
- The four rules that judge what a visitor sees (test_data, tiny_images, duplicate_cards, stale_demo) keep every word list, regex, demo address pattern and threshold in their rule row; code holds no list of its own. A finding names its `selector` and `text`, and one found inside a frame is named `<frame selector> >> <selector>`.
- Duplicate findings (same rule, same values) are kept once, and each rule keeps at most `most_findings_per_rule`.
- `control_name` reads names from Chromium's accessibility tree, matched to selected DOM nodes through CDP backend node IDs and a shared class-free structural identity path. The path uses tag order among visible same-tag siblings; the short class/id path remains separate diagnostic text. The shared measurement owner compares identity, role, name, visibility and availability before and after the in-page measurement; added, removed, replaced, reordered or changed AX evidence is reported as unavailable and refuses that check. Geometry-only movement and proven-hidden control additions or removals do not invalidate the check. This bounded before/after check does not make the page observation atomic or guarantee its future state. Candidate selectors and supported explicit ARIA roles are DATA in `page-craft-rules.json`. Missing, ambiguous or unsupported AX evidence is never treated as an unnamed or named control by a DOM-text guess. The public critic applies this rule to the main document and visible embedded frames that are not explicitly ignored by DATA.
- `input_zoom` (at 390) flags a text field, text area or select whose computed text is under the row's `min_px` (16): a phone zooms the whole page when it is tapped. `sticky_hover` (at 390) flags a `:hover` rule in the page's own style sheets that no media query matching the row's `hover_media` pattern (`(hover: hover)`, `(any-hover: hover)`, `(pointer: fine)`) guards, boxed on the element it styles; it sticks after a tap on a touch screen. Both rules come from the MIT-licensed `mobile-native` skill in github.com/emilkowalski/skills; the code here is written fresh. Style sheets of another origin cannot be read by the page and are passed over. `test/mobile-native.test.mjs` runs the critic against a page planted with a small and a readable field and a guarded and an unguarded hover.

