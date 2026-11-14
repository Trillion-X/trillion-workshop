// packages/ui/show/composer/lazy-composer.ts
//
// Purpose: the message box every screen and menu draws through this part's index. Its body (./Composer.tsx, with the
// recorder, the drop zone and the document editor, about 140 kB) arrives the first time a message box is drawn, so a
// screen that holds one paints before the box's code has come.
//
// Non-negotiable invariants:
// - It is ./Composer.tsx's Composer with the same props; until the body arrives it draws nothing (../load-later).
// - Every caller reaches the message box through the part's index, so this is the one place it is deferred.
import { later } from '../load-later/later';

export const Composer = later(() => import('./Composer'), module => module.Composer);
