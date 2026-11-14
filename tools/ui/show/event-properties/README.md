# EventProperties

`EventProperties` renders caller-owned color, privacy and availability choices with shared Coss selects. The caller may omit unsupported fields, supplies all labels and values, and writes changes through its calendar owner. An edit can use `{ kind: 'keep' }` when a provider value was not loaded; choosing an explicit value emits `{ kind: 'set', value }`. Color swatches are display hints only and do not define a palette. A choice may name the `shortcut` key that picks it while its list is open (drawn beside it), and a two-choice field may be drawn as one `toggle` button that flips between them, saying in its title what pressing it will do.

The component owns no event record, provider schema, defaults, persistence or product copy. It composes the already licensed Coss Select API (MIT provenance in `parts/ui/show/coss/provenance.json`), with its appearance in `parts/screen-look/show/event-properties.css`.

`variant="compact"` places the controls in a wrapping toolbar. Labels remain available to assistive technology and supplied color swatches appear beside the selected value. The Calendar adapter declares provider choices in DATA, omits untouched fields on edits, and sends an explicit nullable color value only when the person chooses the provider default. Optional palette-read failures do not prevent calendar reads or other event edits.

Each field can supply `triggerDisplay` (`choice`, `swatch`, or `icon`) and an icon. A choice may override the icon; hidden trigger text remains available in the menu and the trigger retains its accessible field label and title. Screen Look can compose these controls with compact EventOptions in one wrapping toolbar.
