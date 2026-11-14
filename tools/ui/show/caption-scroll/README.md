# ui/show/caption-scroll

Domain-blind teleprompter and caption-reader surface over caller-owned segments, progress, and status.

## Rules

- `CaptionScroll.tsx` renders only local visual state: active-word emphasis, spoken-word dimming, progress, status/meta labels, and optional manual Back/Forward nudges.
- The component must not own microphone input, speech recognition, timers, recording state, or durable data reads. Callers pass `activeWordIndex`, `spokenWordCount`, and `progress`.
- Segment text arrives already ordered and tokenized by the owning package. `caption-scroll` never guesses script structure or performs alignment.
- `mirrored` draws the whole scroll flipped left to right (`data-mirrored="true"`), so the words read correctly in a teleprompter's glass in front of a lens. The caller decides when; the scroll never knows why.
