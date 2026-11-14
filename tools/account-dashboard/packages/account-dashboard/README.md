# Account Dashboard

Account Dashboard is the Account Portal package surface. Its live authority is
the Account Portal app log; this source folder is proposal material used by the
package live writer to build entry bytes and append the resulting package
records to that log.

The package owns Account Portal presentation and browser-session UX only.
Payment truth, plan policy, activation authority, and signed account effects are
read through descriptor-declared owner targets and remain owned by their
respective packages.

The backend contract is a record-described `SurfaceModel`. Account-related
labels, owner target names, source matching, and action routing live in
`data/account-surface-descriptors.json` and package boundary records. Executable
source folds descriptors and source rows; it does not own account field/status
enums.

The unauthenticated screen uses the shared `screen-look` account-auth classes
and shared `ui` primitives so the public Account Portal keeps the same Bitfield
account identity on desktop and narrow screens.

## Proof

```bash
npx vitest run --config ./vitest.config.ts \
  packages/account-dashboard/tests/account-surface-descriptors.test.ts \
  packages/account-dashboard/tests/account-surface-materializer.test.ts \
  packages/account-dashboard/tests/account-surface-actions.test.ts \
  packages/account-dashboard/tests/account-dashboard-surface.test.tsx
node packages/account-dashboard/show-ios-jscore/account-dashboard-jscore.test.mjs
node -e "JSON.parse(require('fs').readFileSync('packages/account-dashboard/things-to-store-and-run.json','utf8'))"
rg -n "account_plan|license_access|quote_reservation|account_lifecycle|account_status|activation_count|signed-event-authority\\.list-effects|account-session\\.browser-session|account-session\\.login-link|account-session\\.end-browser-session" packages/account-dashboard --glob '!**/data/**' --glob '!**/tests/**' --glob '!**/README.md' --glob '!things-to-store-and-run.json'
rg -n "from ['\\\"].*/packages/(account-session|checkout|payment-adapter|stripe-payment-provider|stripe-payment-elements|activation-manager|product-access|credentials-vault|http-client)" packages/account-dashboard
```
