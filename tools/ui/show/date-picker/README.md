# Date and time controls

The canonical calendar is `DatePicker.tsx`. `TimePicker.tsx` supplies the clock
control, and `DateTimePicker.tsx` composes both. Forms, record cells, filter rules,
calendar scheduling and temporary sharing use these shared controls. They do not
open the browser's date, time or datetime picker.

`DatePicker` takes `todayTone`: `neutral` (the default) draws the chosen day with the accent fill and today as a gray
square; `calendar` is a calendar's own month picker, with today's number in the look's calendar-today colour and the
chosen day a quiet gray square (the calendar header's week crumb opens it).

## Values and storage

- `DatePicker` receives and emits a calendar day (`YYYY-MM-DD`) or `null`.
  Calendar days never pass through a UTC conversion. `min` and `max` are inclusive
  day constraints, including the day at either boundary.
- `TimePicker` receives and emits local `HH:mm`, optionally including seconds and
  milliseconds, or `null`. People may type an arbitrary valid time as well as
  choose a quarter-hour shortcut. Those shortcuts do not restrict precision.
  Clock constraints can cross midnight.
- `DateTimePicker` receives and emits a local `YYYY-MM-DDTHH:mm[:ss[.sss]]` value.
  It publishes `null` while either part is incomplete or the combination is
  outside its inclusive local datetime constraints or names a local time skipped
  by a daylight-saving clock change. The partial draft remains visible so the
  person can correct it. When clocks move back and a local time occurs twice,
  the browser's normal earlier-offset choice is used when the caller converts
  the value to an instant.
- Optional action owners use `onValidityChange` to disable submission while a
  partial or invalid draft is visible. `null` alone cannot distinguish that
  draft from an explicitly cleared optional schedule or expiry. DateTimePicker
  and TimePicker both report validity; clearing the date resets its clock draft.
- The caller owns storage and timezone conversion. A scheduling form may convert
  a completed local datetime to an instant. A date field must keep its day.
- `date-values.mjs` is the shared strict parser and constraint owner. Its
  `localDayBounds` returns local midnight through the instant before the next
  local midnight; daylight-saving days are correctly 23 or 25 hours long.

## Interaction and accessibility

The calendar uses the existing six-week grid and look tokens. Its trigger opens
with Enter or Space. Arrow keys move a day or a week; Home and End move within
the week; Page Up and Page Down change months (with Shift, years). Focus remains
within the inclusive constraints, selected cells expose `aria-selected`, and
each date has a complete accessible name. Escape closes the popup.

The clock accepts typed values and opens its choices with the clock button or
Arrow Down. Arrow keys, Home and End navigate the available choices. Invalid
text remains visible with an explanation and blocks the containing form's
submission. Disabled and read-only controls cannot change their values. Clearing
is explicit and may be disabled for a required field.

Both popups use the shared `LAYER_ORDER.menu` and stop click propagation, so they
work inside record rows, Base UI popovers and phone sheets. A closed popup renders
no portal subtree, preserving the existing fix for invisible overlays swallowing
clicks. The calendar supports controlled opening and `defaultOpen` for inline
record editing. The caller must commit from `onChange`, not from focus leaving
the trigger; focus moves into the popup while a person is choosing a date.

## Usage

```tsx
<DatePicker
  aria-label="Due date"
  value={dueDay}
  min="2026-01-01"
  onChange={setDueDay}
/>

<DateTimePicker
  label="Start"
  value={localStart}
  required
  onChange={setLocalStart}
/>
```

Import these modules directly, or lazily from an existing large surface. Do not
make the generic text `Input` reinterpret `type`: callers with blur-to-save or
inline unmount behavior need an explicit calendar commit path. The default
calendar trigger accepts a label, and a custom `trigger` remains supported.
Clock/layout styling lives in `parts/screen-look/show/temporal-input.css`.

## Verification

`test/date-picker-values.test.mjs` covers strict day and clock parsing,
constraints, local datetimes, leap years, daylight-saving day bounds, skipped
spring-forward times and repeated autumn times.
`test/date-picker-browser.test.mjs` exercises actual controls in Chromium,
including keyboard focus, min/max, local values, arbitrary seconds, one-time
inline commits, failed temporary-sharing updates and nested desktop/phone
popovers. `test/rule-filter-range-narrow-browser.test.mjs` covers date range
endpoints alongside the numeric range control. These isolated browser fixtures
are component evidence; they do not claim a live account or native app test.
