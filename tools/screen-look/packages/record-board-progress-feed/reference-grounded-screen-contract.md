# Recorded work flow screen

The current shared component has event rows but no live mount. The user wants to see messages and findings enter a real flow, with clear visual movement and visible gaps. The supplied HTML prototype is a design reference, not an event source.

Use its roomy page heading, connected source chips, left-to-right path, and attention card as the visual anatomy. Render source names, transitions, and task links solely from `WorkFlowItem`. An unavailable source, stale event, and missing task link must read plainly. New event IDs may animate once; elapsed time alone must not animate a transition.

Empty, sparse, dense, stale, unavailable, desktop, mobile, and reduced-motion states must remain legible. The current source component is the baseline. Runtime mounting and a fresh live event are separate completion evidence.
