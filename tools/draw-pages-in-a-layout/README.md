# draw-pages-in-a-layout

A script a person's AI runs on the person's own computer. It draws a deck's pages as 1080x1350 JPEGs from the exact page
text that was judged, in a layout given as data. Nothing is drawn that was not judged: the tool adds no words, no footer,
no handle and no watermark, and it refuses a line it has no place for.

## The text form

- `PAGE n` starts page n, in order from 1.
- On page 1 the line right after `PAGE 1` is the title. A text in the title between `*stars*` is drawn inside a mark; the stars are not drawn.
- A line starting `- ` is a bullet.
- A line that a bullet follows is a heading.
- Any other non-empty line is refused, and the refusal names it with its line number.

## The request

One JSON object, in a file named as the first argument (or on standard input):

| field | meaning |
|---|---|
| `pages` | the judged text in the form above, one string |
| `layout` | `{css, width?, height?}`: `css` is the CSS from the person's format row (CSS only: a `<` in it is refused); `width` and `height` default to 1080 and 1350 |
| `folder` | an absolute path; made when missing |
| `pdf` | `true` to also print every page into `folder/pages.pdf`, one PDF page each at the page size, words kept as text (for print and for sending as one file) |

The tool styles only its structure: `.p` is the page (sized from `width` and `height`), `.t` the title, `h2` the headings,
and `ul`/`li` the bullets. Everything else about how a page looks is the layout's CSS.

## The answer

The last line on standard output is `{"files": [absolute NN.jpg paths, in page order], "pages": N}`. Each page is also
written as `NN.html` and `NN.png` beside its JPEG. With `"pdf": true` the answer also has `"pdf": "<folder>/pages.pdf"`,
printed from `pages.html` (every page in one sheet). Nothing is written when any page is refused.

A refusal is `{"error": "..."}` with exit status 1, and the same text on standard error. Refusals:

- a line that is not a title, a heading or a bullet (named with its line);
- a page that runs past the page: `page N runs past the page by K px; use fewer words`. Each page is measured on a taller window, which grows until the words end, so K is exact;
- a missing title on page 1, pages out of order, an empty page, a layout with `<` in its CSS, no headless Chromium (CHROME, Playwright's cache or PATH), no JPEG converter (sips on macOS, or ffmpeg).

## How it draws

Headless Chromium takes each page as a screenshot. The overflow check is the background-colour test: the colour of the top-left
pixel is the page's background, and the last row that differs from it is where the words end. The final screenshot is taken
at the page size, and sips (or ffmpeg) turns the PNG into a JPEG at quality 92.

## Run it

```
python3 -m pip install -U pillow
python3 tools/draw-pages-in-a-layout/do-work/draw_pages.py request.json
python3 tools/draw-pages-in-a-layout/test/test_draw_pages.py
```

The tests draw made-up notes pages with the example layout in `test/test_draw_pages.py`. They skip with a reason when
Pillow or a headless Chromium is missing. `test/draw-pages-in-a-layout.test.mjs` runs them and checks that the row's
run command names a file in this folder.
