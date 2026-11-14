// src/workspace/offer-chart.ts
//
// PURPOSE
//   Offers the Chart view to every list on the signed-in page and in a chat card, and tells the chart where a list's own
//   choice is kept: the person's workspace preference `chart-view:<list>` (src/workspace/records.ts), so it is the same on
//   every device. A public share imports the offer without this file, so its chart keeps nothing and bundles no records store.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Imported once when the page starts (main.tsx, screen-view.tsx), before any list draws.
//   2. The store is only handed to the chart here; the chart itself reaches no workspace store.

import '../../parts/ui/show/chart/offer-chart-view';
import { keepChartChoicesIn } from '../../parts/ui/show/chart/chart-choice';
import { useWorkspacePreference, writeWorkspacePreference } from './records';

keepChartChoicesIn({ use: useWorkspacePreference, write: writeWorkspacePreference });
