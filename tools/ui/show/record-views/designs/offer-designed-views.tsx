// parts/ui/show/record-views/designs/offer-designed-views.tsx
//
// PURPOSE
//   Registers the designs this folder draws (chat, thread, rows, inbox, swipe, calendar, matrix, sprints, document,
//   carousel) and offers every row of designed-views.json to every list
//   whose fields fill it (../every-list-views.ts). Imported once when the page starts.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A new view is a DATA row; a new design is one registerViewDesign line here (or in the part that draws it).
//   2. A design's code is fetched the first time a list draws it, never with the page.

import { lazyPart } from '../../load-later/later';
import * as React from 'react'
import {registerEveryListView} from '../every-list-views'
import {designedRecordView, registerViewDesign, type DesignedViewRow, type ViewDesignProps} from '../view-designs'
import {views} from './designed-views.json'

const ChatDesign = lazyPart(() => import('./chat-design'), module => module.ChatDesign)
const ThreadDesign = lazyPart(() => import('./thread-design'), module => module.ThreadDesign)
const RowsDesign = lazyPart(() => import('./rows-design'), module => module.RowsDesign)
const InboxDesign = lazyPart(() => import('./inbox-design'), module => module.InboxDesign)
const SwipeDesign = lazyPart(() => import('./swipe-design'), module => module.SwipeDesign)
const CalendarDesign = lazyPart(() => import('./calendar-design'), module => module.CalendarDesign)
const MatrixDesign = lazyPart(() => import('./matrix-design'), module => module.MatrixDesign)
const SprintsDesign = lazyPart(() => import('./sprints-design'), module => module.SprintsDesign)
const DocumentDesign = lazyPart(() => import('./document-design'), module => module.DocumentDesign)
const CarouselDesign = lazyPart(() => import('./carousel-design'), module => module.CarouselDesign)

registerViewDesign('chat', (props: ViewDesignProps) => <React.Suspense fallback={null}><ChatDesign {...props}/></React.Suspense>)
registerViewDesign('thread', (props: ViewDesignProps) => <React.Suspense fallback={null}><ThreadDesign {...props}/></React.Suspense>)
registerViewDesign('rows', (props: ViewDesignProps) => <React.Suspense fallback={null}><RowsDesign {...props}/></React.Suspense>)
registerViewDesign('inbox', (props: ViewDesignProps) => <React.Suspense fallback={null}><InboxDesign {...props}/></React.Suspense>)
registerViewDesign('swipe', (props: ViewDesignProps) => <React.Suspense fallback={null}><SwipeDesign {...props}/></React.Suspense>)
registerViewDesign('calendar', (props: ViewDesignProps) => <React.Suspense fallback={null}><CalendarDesign {...props}/></React.Suspense>)
registerViewDesign('matrix', (props: ViewDesignProps) => <React.Suspense fallback={null}><MatrixDesign {...props}/></React.Suspense>)
registerViewDesign('sprints', (props: ViewDesignProps) => <React.Suspense fallback={null}><SprintsDesign {...props}/></React.Suspense>)
registerViewDesign('document', (props: ViewDesignProps) => <React.Suspense fallback={null}><DocumentDesign {...props}/></React.Suspense>)
registerViewDesign('carousel', (props: ViewDesignProps) => <React.Suspense fallback={null}><CarouselDesign {...props}/></React.Suspense>)

for (const row of views as DesignedViewRow[]) {
  const view = designedRecordView(row)
  if (view) registerEveryListView(view)
}
