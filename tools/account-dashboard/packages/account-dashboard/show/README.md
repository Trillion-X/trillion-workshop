# account-dashboard/show

React surface source for the account dashboard package.

Customer-facing copy must stay in account language and avoid package/log
implementation terms.

The surface consumes `SurfaceModel` from `read-data/`. It renders descriptor
field categories and action descriptors; it must not read fixed account field
props or re-derive lower-owner effect rows.
