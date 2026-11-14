# activation-pricing/show

Shared pricing display components.

The plan card and billing toggle wrappers publish the package-local painters
from `../source-leaf/show`. The painters accept already
projected descriptor values only: labels, formatted values, enabled flags, and
disabled reasons.

Callers must not pass adjacent-owner internals or re-run backend logic here.
The browser, desktop, and iOS paths consume the same generic terms projection;
layout and visual refinement remain UI implementation work above this backend
projection contract.
