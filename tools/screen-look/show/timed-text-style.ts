export type TimedWordLook = 'white' | 'black' | 'side-panel' | 'under-sound' | 'below-picture';

/** Caption sizing uses complete readable lines, never a fraction of the video. */
export const captionReaderLook = {
  minimumFont: 12,
  maximumDockedFont: 32,
  maximumReadingWidth: 768,
  videoPlayer: 'relative flex max-h-[100dvh] w-full min-w-0 flex-col overflow-hidden rounded-2xl border border-[var(--border-primary)] bg-black shadow-[0_0_20px_rgba(0,0,0,0.2)]',
  picture: 'relative min-h-0 w-full flex-1 overflow-hidden rounded-[inherit] bg-black',
  overlay: 'pointer-events-none absolute inset-0 z-50 overflow-hidden',
  overlayPositioner: 'pointer-events-auto absolute left-0 top-0 cursor-default touch-none select-none',
  dock: 'relative w-full shrink-0 overflow-hidden border-t border-[var(--border-primary)] bg-background text-foreground',
  dockPositioner: 'relative h-full w-full cursor-default',
  dockShell: 'relative isolate mx-auto flex h-full max-w-3xl flex-col',
  dockToolbar: 'relative flex shrink-0 items-center justify-center py-1',
  segment: 'py-1 leading-relaxed transition-opacity duration-200 motion-reduce:transition-none',
  lineHeight: 1.625,
  textInset: 8,
  passageBlockInset: 4,
  inlineInset: 12,
  wordInlineInset: 4,
  frameInset: 16,
  controlsGap: 8,
  readableLines: 2,
  shell: 'relative isolate flex h-full flex-col rounded-lg',
  scroll: 'screen-edge-fade min-h-0 flex-1 overflow-y-auto px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
  toolbar: 'relative z-30 flex shrink-0 items-center justify-center gap-1 py-1 pointer-events-auto',
  fade: 'linear-gradient(to bottom, transparent 0, black min(8px, 15%), black calc(100% - min(8px, 15%)), transparent 100%)',
} as const;

/** Completion uses the existing measured transport reservation. A short
 * picture scrolls its actions above that reservation, without hiding controls. */
export const playbackCompletionLook = {
  overlay: 'absolute inset-x-0 top-0 bottom-[var(--media-playback-controls-inset,0px)] z-30 flex min-h-0 items-center justify-center overflow-hidden bg-background/80 p-2 text-foreground backdrop-blur-sm sm:p-6',
  card: 'max-h-full w-full max-w-xl overflow-y-auto rounded-2xl border border-input bg-popover p-2 shadow-2xl focus-visible:outline-2 focus-visible:outline-ring sm:p-5',
  title: 'text-base font-semibold leading-tight sm:text-2xl',
  actions: 'mt-2 grid gap-2 sm:mt-5 sm:grid-cols-3',
  action: 'min-h-11 w-full whitespace-normal',
  actionContent: 'flex flex-col items-center justify-center',
  actionLabel: 'flex items-center justify-center gap-2',
  detail: 'mt-1 block max-w-full truncate text-center text-xs font-medium text-muted-foreground',
  icon: 'size-4 shrink-0',
} as const;

export function captionShellClass(background: boolean, color: 'white' | 'black') {
  return [captionReaderLook.shell, background ? color === 'white' ? 'bg-black/70 shadow-lg backdrop-blur-sm' : 'bg-white/50 shadow-lg backdrop-blur-sm' : 'bg-transparent'].join(' ');
}

export function captionToolbarClass(background: boolean, color: 'white' | 'black') {
  return [captionReaderLook.toolbar, background ? color === 'white' ? 'border-t border-white/10' : 'border-t border-black/10' : ''].join(' ');
}

/** The existing caption/reader appearance, shared by every timed-word action. */
export function timedWordClass(look: TimedWordLook, active: boolean, past: boolean) {
  const color = look === 'white'
    ? active ? 'bg-white/30 text-white' : past ? 'text-white/90' : 'text-white/50'
    : look === 'black'
      ? active ? 'bg-black/30 text-black' : past ? 'text-black/90' : 'text-black/50'
      : look === 'side-panel'
        ? active ? 'bg-white/25 text-white' : past ? 'text-white/90 hover:bg-white/15' : 'text-white/80 hover:bg-white/15 hover:text-white'
        : active ? 'bg-[color-mix(in_srgb,var(--accent)_20%,transparent)] text-foreground' : past ? 'text-foreground hover:bg-accent' : 'text-muted-foreground hover:bg-accent hover:text-foreground';
  return ['inline rounded px-0.5 text-left transition motion-reduce:transition-none', look === 'white' || look === 'black' ? 'hover:bg-white/20' : '', color].join(' ');
}

export function timedPassageClass(look: TimedWordLook) {
  return look === 'below-picture' ? 'whitespace-pre-line text-left text-foreground' : look === 'white' ? 'text-white/90' : look === 'black' ? 'text-black/90' : look === 'side-panel' ? 'text-left text-white/90 transition hover:text-white' : 'text-left text-muted-foreground transition hover:text-foreground';
}
