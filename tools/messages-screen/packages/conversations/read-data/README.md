# conversations read-data

Direct-feed readers and decoders for the generic conversations owner contract.

Readers consume the three canonical owner feeds and decode computed record/action
and message-page payloads. They do not resolve projection descriptors by address
or decode source-shaped session/transcript fields as the product backend surface.
