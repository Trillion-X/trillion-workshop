# Trillion UI

The RecordViews toolbar pins and reports its position for layout and edge fades. Its background is owned by
screen-look/show/surfaces.css and paints independently of the asynchronous pin observer, so scrolling cannot briefly
expose record text behind the controls. test/record-views-toolbar-paint.test.mjs exercises that unanswered-observer state.

Shared, product-neutral rendering and interaction primitives for Trillion's web and native surfaces.

`declared-props.json` is each part's declaration for screens made of parts (src/screen-spec.mjs): the props it takes (a JSON Schema subset), the prop drawn as its text, whether it holds other elements, its events and the props that report a new value. The renderer (src/workspace/parts-screen.tsx) checks and fixes every element against its row, so a new part for such screens is one row there and its component in src/workspace/declared-parts.ts.

`show/isolated-module-surface` is the shared host for saved screen modules. It keeps their code in a script-only opaque-origin iframe, imports the current page's public module map, and routes named declared requests through the signed-in workspace owner.

`show/focused-surface-host` keeps mounted screens and their unfinished work while navigating between exact addresses. Input updates and their failures stay inside the same host; Back reopens the retained mount.

show/swipe-deck/SwipeDeck.tsx is the reusable card deck used by RecordViews' Swipe layout. It owns touch and pointer
gestures, keyboard choices, Undo, open-on-tap, reduced motion, and the empty-deck state. RecordViews supplies records,
status writes, grouping, tours, and row actions. Its source and adaptation are documented in
show/record-views/designs/README.md; the 21st.dev component source, MIT license, registry version, and BLAKE3 hashes
are recorded in <checkout>/21st-dev/swipe-deck/README.md.

show/read-layout-together/read-layout-together.ts runs the layout reads many parts ask for during one render in one
flush after the render has written the page, so a board of many notes measuring their text is laid out once, not
once per note (see its README).

`show/virtual-list` uses existing MIT @tanstack/react-virtual3.14.8. `followIndex`/`followKey` center a measured row or its `followTarget` inside the list, `followPausedRef` preserves manual reading, and `measurementKey` invalidates cached row heights. Parent width changes also invalidate offscreen heights. A focused stable-key row stays mounted after reordering and scrolling. Distant unmeasured seeks use immediate positioning; already mounted words follow smoothly unless reduced motion is chosen.

`show/inline-text-action` is the shared native word action for a passage. It inherits paragraph type, keeps click/pointer isolation and accepts its appearance from Screen Look. It contains no media timing or record data.

`read-data/widest-text.ts` measures distinct strings with the browser's actual font through a canvas. Consumers memoize it for immutable input/font, independently of resizing or time. It creates no visible nodes and returns zero when browser measurement is unavailable.

`show/coss/ui/menu.tsx` is the public licensed Base UI/Coss menu primitive for composed menu controls, including checkbox and radio choices with native checked state, keyboard focus and the shared phone sheet. Ordinary action lists continue to use `show/action-menu`.

`show/icon/NamedIcon` renders either a named vector or a Unicode symbol through the same Icon sizing and color owner. A literal mark stays visible while vector modules are pending or unavailable; reference pickers and RecordChip use that shared rendering path.
