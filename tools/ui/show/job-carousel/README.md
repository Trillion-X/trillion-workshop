# job-carousel

Several short recordings in one section, one at a time: a list of jobs beside one screen. The chosen job's recording plays, a line under it fills as it plays, and when it ends the next job starts by itself. A visitor can pick any job, or scroll past the whole section.

## Files

| File | Purpose |
|---|---|
| `JobCarousel.tsx` | `JobCarousel`: the tablist of jobs, the chosen job's words, progress line and link, and the one playing recording (in view only, at `rate`, advancing on end; cover and a play button when less motion is asked for) |
| `index.ts` | Barrel: `JobCarousel`, `JobCarouselItem`, `JobCarouselPicture`, `JobCarouselProps`, `JobCarouselRecording` |

## Key Types / Functions

| Name | Signature / Shape | Role |
|---|---|---|
| `JobCarousel` | `(props: JobCarouselProps) => JSX.Element \| null` | The one place raw `<video>`, tab buttons and list markup for a recording carousel are written |
| `JobCarouselProps` | `{ items, label, rate?, renderLink?, playLabel?, pictureMs?, loop?, onFinished?, className? }` | Jobs, the list's spoken name, playback speed (1 = as recorded), the caller's link part, play-button words, how long a picture stays (ms), whether the last job moves on to the first or calls `onFinished`, the caller's class |
| `JobCarouselItem` | `{ id, title, body?, link?: { label, href }, recording?, picture? }` | One job: its title on the tab, its words and link under it when chosen, and what it shows (a recording or a picture) |
| `JobCarouselPicture` | `{ src, alt, width, height }` | A still shown as a job for `pictureMs` (the result a recording leads to) |
| `JobCarouselRecording` | `{ sources: { src, type }[], poster?, alt, width, height }` | The recording's formats, cover, spoken description and real size (reserves its space) |

## Classes the caller styles

`job-carousel` (the grid of list and screen), `job-carousel__jobs`, `job-carousel__job` (`data-active` on the chosen one), `job-carousel__pick` (the tab), `job-carousel__words`, `job-carousel__progress`, `job-carousel__progress-fill`, `job-carousel__body`, `job-carousel__link`, `job-carousel__screen`, `job-carousel__clip`, `job-carousel__video`, `job-carousel__picture` (with `job-carousel__clip--picture` on its frame), `job-carousel__play`.

## Dependencies

**Depends on:** `react` only, so a site without the workspace's packages (gettrillion.ai) can draw it.

**Depended on by:** `chapter-carousel`; gettrillion.ai's landing and `/features/your-ai` (trillion-site `ProductProof.tsx`).
