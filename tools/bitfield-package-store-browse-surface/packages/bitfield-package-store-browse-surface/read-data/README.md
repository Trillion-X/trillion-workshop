# Browse Surface Readers

This folder owns package-store browse read models.

- `read-catalog-view.ts` accepts the legacy catalog snapshot or the generic
  `generic.record_action_projection.v1` projection.
- `read-jscore-package-store-view.ts` exposes the same pure read path for iOS
  JSCore/native shell consumers, including lightweight founder composition
  records and package-card refs.

React and JSCore consume the same projection bytes. Device-specific rendering
must not reimplement package-store logic.
