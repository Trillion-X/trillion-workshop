# subject-participant/do-work/

Work builders in this package create owner-action request payloads only.

They do not execute external owners, call providers, import owner internals, open databases, or perform source-system writes. Package-set data decides which owner answers each request.

Owner-action requests declared by this package:

- `request-subject-entry`
- `update-subject-participant`
