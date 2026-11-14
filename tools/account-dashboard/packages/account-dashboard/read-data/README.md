# account-dashboard/read-data

Readers in this folder fold descriptor rows and owner-translated source rows
into the generic Account Dashboard `SurfaceModel`.

Payment, activation, entitlement, session, and signed-event authority remain in
their owning packages. This folder can read descriptor keys, field descriptors,
action descriptors, source rows, freshness, diagnostics, and relationships; it
must not grow account-specific status or field enums.
