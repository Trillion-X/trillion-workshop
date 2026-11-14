# investment-command/show

Trading Center is a cockpit/workspace shell over owner-fed package surfaces.

| File | Purpose |
| --- | --- |
| `InvestmentCommandPanel.tsx` | Renders the tiled trading workspace by default; renders the reference-grounded hero cockpit when `surfaceInput.trading_surface` is `overview` — big equity, today's P&L vs the 5% daily goal (progress bar), buying-power StatStrip, the agent's live watchlist momentum signals + translated hold-reason, and recent placed orders, all read from the live agent `last_cycle` fact. |
| `mount-investment-command.tsx` | Entry adapter that passes `surfaceInput` from screen-arrangement tabs into `InvestmentCommandPanel`. |

Hero/agent-activity anatomy is reference-grounded: Fidelity account hero (mobbin `0dd015e1`) for the equity + P&L + balances, Copilot Money movers (mobbin `443f8c14`) for the watchlist the agent evaluated. All numbers come from the agent's own published fact via `../read-data/read-trading-agent-cycle.ts` — no fake data; absent fields degrade to honest empty text.

The workspace embeds `screen-arrangement` with `placeable-surface-list::trading-workspace`. Sidebar and top-level empty states keep reading `placeable-surface-list::main-workspace`; owner packages remain separate data owners.
