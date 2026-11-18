# tools/invite-people-to-a-space-by-link-email-address/

Invite people to a space by link, email address or phone number and show the invitation in every state it can be in.

This folder has no row yet. Its old Trillion files are in `from-an-older-version/`: the bytes of tag `old-trillion-before-worker-retire`, under their old paths. `from-an-older-version/README.md` says which load here and which are held until what they import is here. Wiring them into a row is adapting them, in a commit that names `moved-from.json`.

The exact source baseline in `source-baselines/link-invitations.mjs.held` is
`b6ae0ebf81` `src/spaces.mjs:803–963`. Its invitation methods own the
next adaptation: make, list, revoke, admit, preview and join. A normal baseline
commit must precede activation. The earlier behavioral sketch was removed;
its eight passing stand-in controls were not a source-qualified port.

Link invitations must retain current membership, invitation expiry, one-time
claim and retry rules. Addressed email and phone invitations must refuse when
their address proof is unavailable; naming an address is not proof. Configured
roles and policy must use their existing owners or refuse as unavailable.
Mail, phone delivery and payment steps are outside the link-only proof.
The engine already owns sealed values and native act grants. An ordinary child
tool cannot keep its parent account's standing grant. Activation must compose
the existing full account admission, private custody, recipient proof and grant
revocation without putting a bearer into tool input, output, records or links.
