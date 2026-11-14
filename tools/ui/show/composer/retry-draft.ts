import type { ComposerDraft } from './Composer';

/** Reuse a failed send's draft while its contents stay the same. A changed or successful draft starts a new send. */
export function retryDraft(previous: ComposerDraft | null, next: ComposerDraft): ComposerDraft {
  const same = <T>(left: T[], right: T[], equals: (a: T, b: T) => boolean = (a, b) => a === b) =>
    left.length === right.length && left.every((value, index) => equals(value, right[index]));
  return previous && previous.text === next.text && same(previous.files, next.files) && same(previous.links, next.links)
    && same(previous.mentions, next.mentions, (a, b) => a.kind === b.kind && a.value === b.value && a.label === b.label)
    ? previous : next;
}
