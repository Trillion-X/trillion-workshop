# Navigation history controls

`NavArrows` is the domain-blind back/forward control. An optional `historyItems`
list adds the same bounded shared dropdown to each enabled chevron; callers own
the labels, current reference, disabled entries, and navigation callback.
`Dropdown.openOnHover` keeps that panel open while the pointer moves from the
trigger into the portaled menu. Keyboard opening and selection continue through
the existing dropdown list behavior.

Screen arrangement supplies its per-container visited-tab trail and persists a
directly selected entry by moving that container's history cursor. Tab bars use
the same `DockablePlacementState` primitive as the sidebar, so their saved edge
and visibility mode remain independent for each container.
