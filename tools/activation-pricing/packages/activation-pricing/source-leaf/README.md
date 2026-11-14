# activation-pricing source leaf

This leaf is the package-local implementation for the publication wrappers in
the parent folder.

The backend primitive is a generic terms projection: records, field descriptors,
rule descriptors, relationship descriptors, action descriptors, and process
descriptors are data. Package labels and human copy can be supplied by package
records, but the code does not branch on those labels.

Focused proof:

```bash
cd /workspace/the-owner/dev/bitfield-packages
node --test packages/activation-pricing/source-leaf/read-data/activation-pricing-model.test.mjs
node --test packages/activation-pricing/source-leaf/view-model/build-view-section-model.test.mjs
node --test packages/activation-pricing/source-leaf/show-ios-jscore/mount-activation-pricing-jscore.test.mjs
```
