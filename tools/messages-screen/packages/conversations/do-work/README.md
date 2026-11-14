# conversations do-work

Generic owner-action validation and dispatch for canonical addressed exchanges.

The package exports semantic action identities and the fail-close owner adapter.
Callers dispatch upsert, ordered append, open/close/consent, and explicit
projection publication; no surface-specific refresh/rename wrapper belongs here.
