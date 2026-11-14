# account-dashboard/do-work

Descriptor-built read and action requests for the account dashboard package.

Owner target names and action payload mappings come from
`data/account-surface-descriptors.json`. Code in this folder builds generic
target requests and invokes the Runtime Kit target lane; it does not import
adjacent owner packages or hardcode account/session/effect targets.
