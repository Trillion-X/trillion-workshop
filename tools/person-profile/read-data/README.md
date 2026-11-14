# Person Profile Read Data

Read-data code interprets `described-record-surface` descriptors. It does not know profile field names, viewing modes, contribution kinds, workflow ids, or adjacent owner storage formats.

The primitive input is descriptor data plus source records. The output is a reader-safe materialization with identity, fields, relationships, actions, and diagnostics.
