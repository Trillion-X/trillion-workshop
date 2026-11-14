# access-scoped-content/show

React surface source for displaying access-scoped, screen-ready content records.

Visible copy must stay in product language and must not expose package-admission, log, or backend implementation terms.

Paid or otherwise gated rows declare `required_access_refs` in their projection DATA. The surface resolves the current browser session, reduces the account's durable `license_access` effects, and fails closed while the owner read is loading, malformed, timed out, or unavailable. Static `available: true` is never sufficient for a gated row.

An available row whose `render_surface.surface_input` provides an HTTPS `download_url`, safe `file_name`, and human `download_label` renders one accessible `Download {download_label}` action. The URL is not placed in the DOM until the matching access grant has been resolved.
