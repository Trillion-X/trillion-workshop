# trade-order/show

The Order surface — an order ticket for composing a checked order and an order history of the autonomous agent's live orders.

## Files

| File | Purpose |
|------|---------|
| `TradeOrderPanel.tsx` | Top-level surface: reads the live cycle snapshot via `useBitfieldData`, decodes it, and composes the ticket + history. |
| `OrderTicket.tsx` | Compose-and-review order ticket (Stake/Public anatomy): Buy/Sell, Limit/Market/Stop, Price/Shares/Amount, live Buying Power, Review → confirm summary. |
| `OrderHistory.tsx` | Dense order rows from the live snapshot: status, human label, side/size/type/limit, real fill detail, broker order ref, failure reason, time. Renders every state in be-exec's matrix (queued/partial/filled/rejected/error/empty). Honest count-only state when per-order rows are absent. |
| `mount-trade-order.tsx` | Surface mount entry — wraps the panel in the floating material frame + error boundary. |

## Key Types / Functions

| Type / Function | Signature | Role |
|-----------------|-----------|------|
| `TradeOrderPanel()` | `() → JSX` | Surface root; reads `useBitfieldData(tradeOrderCycleInput.inputName)` and composes the sub-surfaces. |
| `OrderTicket({ account, guardrailLine })` | `OrderTicketProps → JSX` | Order ticket; Buying Power reads `account.buyingPower`. |
| `OrderHistory({ orders, openOrderCount, ordersPlacedCount, hasLiveSnapshot })` | `OrderHistoryProps → JSX` | Live order rows + working/placed counts. |
| `mount({ el, props })` | `MountArgs → unmount` | Mounts the surface into a host element. |

## Dependencies

- **Depends on:** `@/packages/ui` (Badge, Button, Card, Container, Divider, EmptyPlaceholder, Icon, Input, ScrollableSurface, SegmentedControl, StatusDot, Text), `@/packages/trade-order/read-data` (`decodeTradeOrderLive`, `tradeOrderCycleInput`, order types), `@bitfield/runtime-kit/react` (`useBitfieldData`), `lucide-react`.
- **Depended on by:** the package entry `trade-order` (via `mount-trade-order.tsx`).

## Reference anatomy

- Order ticket ← Stake order ticket (Mobbin `ef1205cf`): Bid/Ask, Limit/Market/Stop, Price/Shares/Amount, Buying Power, Review.
- Confirm summary ← Public/Lightyear confirm (Mobbin `6bdaf05e`): Buy {symbol} · {order type}, key/value summary, Send order.
- Order history ← brokerage activity rows (Stake "Active orders", Fidelity activity): dense one-line-per-order rows.

## Render-state matrix (be-exec order/fill contract)

`OrderHistory` maps the executor's `status` + broker `broker_status` + `broker_http_status` to one honest state per row — never synthesizing a fill (L117):

| State | Trigger | What renders |
|-------|---------|--------------|
| Queued | `accepted`/`new`, `filled_qty 0` | "Queued · awaiting fill", submitted qty + limit, NO fill price |
| Partially filled | `0 < filled_qty < qty` | "Partially filled", "Filled X of Y @ avg" |
| Filled | `filled_qty >= qty`, price + time set | "Filled", "Filled N @ price", fill time |
| Rejected | broker rejected a well-formed order | "Rejected" + the reason from `broker_response` |
| Broker error | `broker_http_status` not 2xx — the call itself failed | "Broker error" + the error message |
| Empty | order-set `orders:[]` / absent | "No orders yet" (or "Connect the account" when no snapshot) |

The broker order id (`broker_order_id`) renders as a short `Ref ########` line per order.

## Invariants

- Zero raw HTML, zero `className` — composition is via `@/packages/ui` primitive props only (L065).
- All rendered data is real (from the live cycle snapshot). No demo orders; honest empty/connect states when data is absent.
- A fill price / "filled" state appears ONLY when the broker reports `filled_qty > 0` and a real `filled_avg_price` (L117). The 6 currently-queued orders render as "Queued", never filled.
- `rejected` (broker said no) and `error` (broker call failed) are distinct terminal states with distinct copy — the user sees which kind of failure occurred.
- Visible copy is trading language; no internal/backend vocabulary.
