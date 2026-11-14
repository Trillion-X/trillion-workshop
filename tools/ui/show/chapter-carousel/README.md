# chapter-carousel

Several sets of short recordings and pictures in one section, for example one set per use case: a row of the sets that scrolls sideways, and under it the chosen set's own carousel (`job-carousel`). When a set's last step ends, the next set starts by itself. A visitor can pick any set, any step in it, or scroll past the whole section.

## Files

| File | Purpose |
|---|---|
| `ChapterCarousel.tsx` | `ChapterCarousel`: the horizontal tablist of sets (scrolls sideways, keeps the chosen set in view without moving the page) and the chosen set's `JobCarousel`, moving on to the next set when it finishes |
| `index.ts` | Barrel: `ChapterCarousel`, `Chapter`, `ChapterCarouselProps` |

## Key Types / Functions

| Name | Signature / Shape | Role |
|---|---|---|
| `ChapterCarousel` | `(props: ChapterCarouselProps) => JSX.Element \| null` | The one place the row of sets and its tab buttons are written |
| `ChapterCarouselProps` | `{ chapters, label, stepsLabel?, rate?, pictureMs?, renderLink?, playLabel?, className? }` | The sets, the row's spoken name, each set's steps' spoken name, playback speed, how long a picture stays, the caller's link part, play-button words, the caller's class |
| `Chapter` | `{ id, title, items: JobCarouselItem[] }` | One set: its title on the row, its steps (recordings or pictures) |

## Classes the caller styles

`chapter-carousel`, `chapter-carousel__sets` (the row), `chapter-carousel__set` (a set's tab, `data-active` on the chosen one), `chapter-carousel__stage`, plus every `job-carousel__*` class inside the stage.

## Dependencies

**Depends on:** `react`, `../job-carousel/JobCarousel`.

**Depended on by:** gettrillion.ai's landing (trillion-site `ProductProof.tsx`).
