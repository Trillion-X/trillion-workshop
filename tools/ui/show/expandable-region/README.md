# ExpandableRegion

A scrollable area that starts at a useful height, can be resized by dragging or keyboard, and can reveal all of its content with “Show more”. Use for long content whose reading height should stay with the person.

## Public API

| Part | Props | Purpose |
| --- | --- | --- |
| `ExpandableRegion` | `{ children, initialHeight?, minHeight?, maxHeight?, moreLabel?, lessLabel?, className? }` | Scrolls long content inside a height cap, provides a keyboard accessible resize separator, and toggles between the chosen cap and the full content height. Set `lessLabel` to `null` when the consumer already owns the collapse action. |

Default heights are 240 px initially, 96 px minimum, and 480 px maximum. `ArrowUp` and `ArrowDown` adjust the cap by 16 px; `Home` and `End` select the limits. |

## Design reference

The drag affordance follows the visible handle anatomy of 21st.dev Resize Handle, component 19345, adapted as an original horizontal grip with keyboard support. No registry code was copied. Mobbin search was unavailable in this session.

## Dependencies

`../button`, `../cn`, React.
