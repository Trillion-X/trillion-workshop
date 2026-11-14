# do-work

This package does not execute owner actions.

`record-board-progress-feed` publishes action descriptor data that existing
owners and workflow targets can execute. Runtime action calls stay with Record
Board and the target owner. This folder is intentionally documentation-only for
the backend implementation because the logic plan forbids local retry,
continue, proof-open, workflow, process, or target execution code here.

Allowed work:

- build package proposal data;
- document action descriptor copy rules;
- record import/proof receipts.

Forbidden work:

- `engine.operation` writes from package runtime code;
- direct `fetch`;
- direct `sendRequestToBitfieldTarget`;
- process/session launch or retry logic;
- workflow dispatch branches keyed by action names.
