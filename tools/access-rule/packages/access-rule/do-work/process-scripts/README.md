# Process Scripts

Access Rule package code does not spawn native processes.

When a package set supplies non-pure rule work, the rule record points at the
existing Runtime Kit process targets with descriptor data:

- `compute.process`
- `compute.process_session`

The process output comes back as evidence records consumed by the same
evaluation fold.
