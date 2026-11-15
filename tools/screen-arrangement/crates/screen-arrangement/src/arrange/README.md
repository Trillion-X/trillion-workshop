# slot_work/

Pure screen-arrangement transition logic lives here. The slot owns geometry, tab membership, focus, and arrangement state transitions; it does not interpret package identities or render package UI.

Closing the final tab leaves the single remaining container and tab group in an empty state. That empty state is the durable substrate the browser picker can refill through the same generic placeable-surface path.

Incoming arrangement state is normalized before every operation. Containers, tab groups, tabs, layout surfaces, focus, and maximized state must form one valid graph; stale tab IDs are pruned before any mutation runs.

Container-adjacent split operations use the same `before` / `after` coordinate as root splits. Browser chrome may label those coordinates as left/right/above/below, but the slot only sees generic split direction plus position.

Each split keeps, for every child, its length along the split (`sizes`, shares or layout pixels per `sizeUnit`), optionally its own length across the split (`crossSizes`, pixels or null to fill; set by `resizeCross { path, index, length }`), and `keepLengths` (pixel lengths drawn exactly while the arrangement scrolls). Every operation carries those with the child they belong to (`arrange_split_surfaces.rs` `SplitParts`). `splitContainer` halves its target (`NewPaneLength::Half`); `addPaneBeside { containerId, dir, position, lengthPx, targetPx }` adds a pane at its own length while every pane keeps the length it is drawn at, turning a share split into the pixels it stands for (`NewPaneLength::Beside`).

A row may carry `stack_below` (pixels): the page draws it as a stack of its panes when its stage is narrower; the slot keeps it through every operation and never acts on it. In a pixel split a length of 0 is kept (the child is drawn at its content's length); in a share split it is dropped like any length that is not positive.
