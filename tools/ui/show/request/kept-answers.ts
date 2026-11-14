// parts/ui/show/request/kept-answers.ts
//
// Purpose
//   The one signal between a read that answers from a copy kept on this computer (kept-values.ts) and the loaders
//   that draw what reads answer (screen-state/ScreenState.tsx). The read answers at once with the kept copy and
//   asks the network in the background; when the network's answer differs from the copy it answered with, the
//   loaders that drew a kept copy read again, and the read then answers with the network's answer.
//
// Non-negotiable invariants
//   - Only a read a loader starts may answer from a kept copy (`readWithKeptAnswers` around the loader's read), since
//     only a loader reads again when the copy is replaced; any other read always asks the network. A read the loader
//     starts after waiting on another is outside the welcome and asks the network too, which is only slower.
//   - A loader learns whether its read was answered from a kept copy by the served count moving while it read
//     (`keptAnswersServed` before and after), so no read has to know which loader asked it.
//   - `keptAnswerReplaced` is said only when a kept copy that was drawn turned out to differ; a copy the network
//     confirms says nothing, and nothing is drawn twice. It names the address whose copy was replaced, so a reader
//     that drew several (the page's own first reads) reads again only that one.
//   - Nothing here keeps, reads or compares answers: that stays with the read that owns them.

let served = 0
let welcome = 0
const listeners = new Set<(path: string) => void>()

/** Runs a loader's read with kept copies welcome for the reads it starts before its first wait. */
export function readWithKeptAnswers<T>(read: () => Promise<T>): Promise<T> {
  welcome += 1
  try { return read() } finally { welcome -= 1 }
}

/** Whether a read starting now may answer from a kept copy. */
export function keptAnswersWelcome(): boolean { return welcome > 0 }

/** Said by a read each time it answers from a kept copy. */
export function keptAnswerServed(): void { served += 1 }

/** How many reads have answered from a kept copy since the page opened. */
export function keptAnswersServed(): number { return served }

/** Said by a read when the network's answer at `path` differs from the kept copy it answered with. */
export function keptAnswerReplaced(path: string): void { for (const listener of [...listeners]) listener(path) }

/** Hears each replaced kept answer, with its address; returns the way to stop hearing it. */
export function onKeptAnswerReplaced(listener: (path: string) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
