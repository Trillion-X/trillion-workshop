// src/workspace/offer-draw-design.tsx
//
// PURPOSE
//   Registers the `draw` design (./draw-design.tsx: any list on the board) so the designed views' Draw row
//   (parts/ui/show/record-views/designs/designed-views.json) is offered to every list. The design lives in the
//   workspace because the board is a workspace screen (./board-of.tsx), which a shared part never reaches into.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Imported once by each page entry (main.tsx, screen-view.tsx) before the designed views are offered.
//   2. The design's code is fetched the first time a list draws it, never with the page.

import React from 'react';
import { lazyPart } from '../../parts/ui/show/load-later/later';
import { registerViewDesign, type ViewDesignProps } from '../../parts/ui/show/record-views/view-designs';

const DrawDesign = lazyPart(() => import('./draw-design'), module => module.DrawDesign);

registerViewDesign('draw', (props: ViewDesignProps) => <React.Suspense fallback={null}><DrawDesign {...props} /></React.Suspense>);
