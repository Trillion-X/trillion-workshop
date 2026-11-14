# activation-pricing

`activation-pricing` owns the package-local explanation of configured terms
before a user continues to another owner.

The public files in this folder are publication wrappers. The implementation
lives in `source-leaf/`, where generic records,
descriptors, relationships, actions, and process descriptors are projected into
one read model. Adjacent owners execute their own work through opaque action
targets; this package does not create sessions, mutate access, or call payment
providers.

Focused proof:

```bash
cd /workspace/the-owner/dev/bitfield-packages
node --test packages/activation-pricing/source-leaf/read-data/activation-pricing-model.test.mjs
node --test packages/activation-pricing/source-leaf/view-model/build-view-section-model.test.mjs
node --test packages/activation-pricing/source-leaf/show-ios-jscore/mount-activation-pricing-jscore.test.mjs
```
