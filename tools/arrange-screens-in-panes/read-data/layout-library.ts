// parts/screen-arrangement/read-data/layout-library.ts
//
// The layouts a person's AIs make, kept as a kept library of the group part (parts/group/read-data/kept-library.ts)
// configured by its row, ../layout-library.json: their categories and Recent. Read the same way by the store that
// writes it (src/layouts.mjs) and by the Layouts menu (show/LayoutPicker.tsx), so both always agree.

import library from '../layout-library.json'
import type { KeptLibrary } from '../../group/read-data/kept-library'

/** The row the layouts' categories and Recent are kept by. */
export const LAYOUT_LIBRARY: KeptLibrary = library
