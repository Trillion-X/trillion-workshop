# RotatingCarousel

MIT Cult UI cylinder-carousel adaptation. Pass `items` with stable `id` values,
`renderItem`, optional `initialId`, `onActiveChange` and an accessible `label`.
Only the active face is interactive; arrows, horizontal drag and keyboard wrap
through the items. Reduced motion keeps selection without animated rotation.

Use `screen-look/show/rotating-carousel.css`. Expansion consumes it through
`mountMediaGrid({layout:'carousel'})`, retaining its existing shared Coss cards.
Original source and adaptation record:
`<design-systems>/cult/3b855612fb524cb042cc91b65f0cd575057471cc/`.
