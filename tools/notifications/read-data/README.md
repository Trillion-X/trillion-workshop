# Notifications Read Data

This folder contains the package-local pure projection for notification policy
records. `read-notifications-policy.ts` consumes descriptor records, current
value rows, and action-route records, then returns a serializable setting-policy
view for browser and JSCore consumers.

The reader treats option ids as opaque data. It does not correct unknown saved
values, import lower-owner packages, or implement side effects.
