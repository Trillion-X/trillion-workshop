# Calendar booking primitives

The availability calculator, external calendar adapters and invitation-file
builder remain shared primitives. Personal availability links use
`createAvailabilityLinkOwner`; `availabilityLinkEeafStore` adapts its records to
the caller's existing EEAF and SQLite owner. There is no additional database,
queue, clock, credential store or screen implementation.

The link lifecycle is create, read, list, edit, revoke, restore and delete.
Recipients can read offered times, reserve, read their reservation, move, cancel
and reconcile the original operation. Revocation prevents new bookings while
existing recipients retain their authorized cancellation path. Deletion keeps
the retained reservation/recovery records; it does not silently cancel meetings.

A link may offer several seats at one time (`seats_per_slot`) and may ask the
organizer to confirm each booking (`requires_confirmation`). Each seat is its
own reservation and its own calendar event; the owner passes the link's other
seat events to the busy read (`exclude_events`) so they never make the time look
busy, and counts the seats inside the same synchronous transaction that writes
the reservation, so two people racing for the last seat cannot both have it. A
different time that overlaps a seated time stays blocked. A recipient holds at
most one seat at a time. A link with seats cannot have co-hosts and needs a
calendar that lists events, not only busy times. A request (`requested`) is
recorded without a calendar change; it holds its time only when the link says
so (`pending_blocks_slot`). The organizer `confirm`s it (the time must still be
open; the event is made then and the reservation follows the ordinary pending to
booked path), `decline`s it (no calendar change, the time is freed), and can
list a link's reservations by state (`reservations`). The person who asked can
withdraw a request with `cancel` but cannot move it.

A link with co-hosts shares its times by `host_mode`: `everyone` (the default:
every host attends, so a time must be free for all of them) or `take_turns` (a
time is offered when any one host is free; each booking goes to one host, the one
with the fewest bookings around that time for their weight, `host_weight` on the
link's own calendar and `weight` on a co-host; a tie goes to the earlier host).
The booking is then that host's alone: its calendar event is made on that host's
calendar, and a move or cancel stays with that host. Which hosts are free is
never shown to the visitor.

All links for a calendar incarnation must route to the same reservation
invariant owner. The EEAF adapter queries both original and pending occupied
intervals across links on that exact calendar. Its indexed compound keys retain
millisecond precision without scanning unrelated calendars or materializing an
unbounded matching result. An incomplete read refuses the offered time. The
resource transaction must include both the reservation and operation writes;
rollback also clears uncommitted EEAF cache entries.

Management and recipient rights require fresh admission and synchronous
commit checks. A recipient principal is supplied by verified recipient
admission, never by a shared link code, a name or an unverified email. Recipient
replies exclude provider identifiers, calendar/connection identities, cohost
configuration, raw errors and frozen task inputs. Rights are checked again
after external waits. Private management reads retain the original evidence.

Busy reads and effects must use the reservation's original calendar when moving
or cancelling, including its connection incarnation. Busy suppliers must check
every declared cohost and refuse unreadable calendars. Those guarantees still
need qualification against the real connection and recipient suppliers. Domain
tests with injected callbacks do not establish them.

The durable effect owner must admit and recover the same original operation ID
and frozen input. Pending or uncertain effects retain their occupied intervals.
Reconciliation may inspect that original effect; it must not blindly send a
provider mutation again. A confirmed event identity is required for booking.

These public package APIs are composed by `src/native-availability-owner.mjs`
with the native Calendar, Workshop and sharing suppliers. Calendar settings
mount the shared `AvailabilityLinks` surface through recursive arrangement DATA;
its callbacks use `/work/api/calendar/availability`. The native-host test covers
creation, cold-reopen listing and admission revocation. Its provider and sharing
suppliers are test doubles: this does not prove a real provider booking or a
customer-accessible hosted result. The existing paid-access booking flow remains
a separate domain.

October 14 qualification: 18 injected-domain cases and 9 real EEAF/SQLite cases
passed, including competing links, exact calendar incarnations, original
effects, public projection, late revocation, bounded reads, history, rollback
and physical cold reopening. No real provider event or public booking was
created by these tests.
