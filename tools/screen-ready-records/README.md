# screen-ready-records/

Reads the rows a screen is handed into a plain list, brought from bitfield-packages `packages/screen-ready-records` (commit c8c5c88f4) because media-playback's read-data sits on it.

## Files

| File | Purpose |
|------|---------|
| `read-data/read-screen-ready-records.ts` | `readScreenReadyRecords(source, options)`: the records inside whatever shape a screen was handed. |
| `part.json` | Public file: `read-data/read-screen-ready-records.ts`. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `readScreenReadyRecords` | `(source: RecordSource, options?: ScreenReadyReadOptions) => ScreenReadyRecords` | The rows of a screen's source, whatever envelope they arrived in. |

## Dependencies

**Depends on:** nothing.

**Depended on by:** `../media-playback/read-data/read-media-playback.ts`.
