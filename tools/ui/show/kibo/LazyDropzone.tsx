// parts/ui/show/kibo/LazyDropzone.tsx
// The Dropzone and its empty state, fetched the first time one is drawn (../load-later). The file-selector and
// react-dropzone libraries behind them are large, and a screen that offers a drop area shows it beside its own
// content, so it loads them then instead of with the screen. Both come from the one ./dropzone module, so the empty
// state reads the same Dropzone's context.
import { later } from '../load-later/later';

export const LazyDropzone = later(() => import('./dropzone'), module => module.Dropzone);
export const LazyDropzoneEmptyState = later(() => import('./dropzone'), module => module.DropzoneEmptyState);
