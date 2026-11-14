# ui/show/selectable-pill-bar/

Pure selectable pill-row rendering.

It knows only caller-provided item ids, labels, selected ids, and callbacks. It
does not know projects, tasks, knowledge records, feeds, actions, or slots.

Rules:

- No addressed reads.
- No target invokes.
- No durable state.
- No package-specific vocabulary.
