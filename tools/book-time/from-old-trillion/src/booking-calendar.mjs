// The booking calendar: the Durable Object that held one host's session grants and bookings before booking became
// availability links on the host's own calendar (parts/calendar-booker, src/native-availability-owner.mjs). It runs
// nothing now. Its one method hands its stored rows to the one-time raw export (src/resource-host.mjs exportHere, asked
// by the operator through POST /mcp/api/storage/export-store), so the grants and bookings can be checked and taken into
// availability links (the published workflow that takes earlier bookings into a link). The class and its storage are deleted by a migration
// only after that export is verified.
import { DurableObject } from 'cloudflare:workers';

export class BookingCalendar extends DurableObject {
}
