# activation-manager/show-ios-jscore

JavaScriptCore native screen-command entry for `activation-manager`.

The mount reads the same decoded activation projection used by the browser
surface: `activationState.activations[]` rows may carry `statusView`,
`nextActions`, and `proofRows`. The JSCore file does not import React, touch the
DOM, or branch on activation state names. Status labels, tones, disabled
reasons, owner targets, and operation names are projection data.

Native proof:

```bash
cd ~/dev/bitfield-packages
npx vitest run --config ./vitest.config.ts packages/activation-manager/show-ios-jscore/mount-activation-manager-jscore.test.ts
```

The test loads the mount through `node:vm`, feeds the decoded projection shape,
captures `native.view.snapshot.replace`, and verifies action presses are sealed
`runtime.target.invoke` operations built from action descriptor data.
