# calendar-booker iOS JSCore

This folder contains the native screen-command entry for `calendar-booker`.

The mount consumes the same owner-translated `ViewDescriptor[]` contract used by
the browser surface. It does not import browser UI code, create a mobile backend,
or interpret package states. Human labels, status text, tones, fields, options,
and action labels arrive as package data.

## Contract

- Input: `calendar-booker-view-descriptors`, mount `props.views`, or the Swift
  native screen-record `props.views` envelope.
- Actions: `calendar-booker-action-descriptors`, mount
  `props.actionDescriptors`, or the Swift native screen-record
  `props.actionDescriptors` envelope.
- Output: sealed `native.view.snapshot.replace` and `native.view.snapshot.dispose`
  operations.
- Presses: sealed `runtime.target.invoke` operations built from
  `owner_action_descriptor` rows. The visible action `action_ref` is resolved by
  exact descriptor identity first, then the same trailing-slug alias rule used by
  the browser helper.

## Proof

```bash
node packages/calendar-booker/show-ios-jscore/mount-calendar-booker-jscore.test.js
npx vitest run --config ./vitest.config.ts packages/calendar-booker/show-ios-jscore/mount-calendar-booker-jscore.test.ts
rg -n "calendar-booker-mobile|localStorage|fetch\\(|Google|Outlook|React|document\\.|window\\." packages/calendar-booker/show-ios-jscore --glob '!README.md' --glob '!*.test.js' --glob '!*.test.ts'
```
