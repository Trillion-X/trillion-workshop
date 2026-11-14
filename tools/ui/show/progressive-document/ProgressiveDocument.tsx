import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Asterisk, ArrowRight, Circle, Diamond, Square } from 'lucide-react';
import { Button } from '../coss/ui/button';
import { Badge } from '../coss/ui/badge';
import { Reveal } from '../reveal/Reveal';
import { readLayoutTogether } from '../read-layout-together/read-layout-together';
import { paragraphDepth, partGroups, type ProgressiveDocumentData, type ProgressivePart } from './model';

type ReadingAnchor = { element: HTMLElement; top: number };

const wordSpans = (text: string, prefix: string) => text.split(/(\s+)/).map((word, index) =>
  /^\s+$/.test(word) ? word : <span key={`${prefix}-${index}`} data-document-word="" className="progressive-document__word">{word}</span>);

/** A caller-named term stays inside its original sentence and shared Badge. */
function passageWords(part: ProgressivePart) {
  const start = part.term ? part.text.indexOf(part.term) : -1;
  if (start < 0 || !part.term) return wordSpans(part.text, 'text');
  return <>{wordSpans(part.text.slice(0, start), 'before')}<Badge variant="outline" size="lg"
    className="coss-ui progressive-document__term">{wordSpans(part.term, 'term')}</Badge>{wordSpans(part.text.slice(start + part.term.length), 'after')}</>;
}


/** One continuous argument. Depth adds source-ordered inline spans in place;
 * local marker choices affect only their own insertion. Caller DATA owns words. */
export function ProgressiveDocument({ document: data }: { document: ProgressiveDocumentData }) {
  const root = useRef<HTMLElement>(null);
  const instanceId = useId().replace(/:/g, '');
  const [depth, setDepth] = useState(0);
  const [localVisibility, setLocalVisibility] = useState<Record<string, boolean>>({});
  const anchor = useRef<ReadingAnchor | null>(null);
  const beforeLayout = useRef<Map<HTMLElement, { left: number; top: number }> | null>(null);
  const layoutAnimations = useRef(new WeakMap<HTMLElement, Animation>());
  const observedScrollY = useRef<number | null>(null);
  const wheelAccumulation = useRef(0);
  const lastWheelAt = useRef(0);
  const touchStartDistance = useRef<number | null>(null);
  const currentDepth = useRef(depth);
  currentDepth.current = depth;
  const [instantBefore, setInstantBefore] = useState<Set<string>>(() => new Set());
  const [ready, setReady] = useState(false);

  // Keep the reading paragraph at the same viewport position while text above
  // or within it is inserted. Paragraphs before the reader arrive without motion.
  const rememberAnchor = useCallback((x?: number, y?: number) => {
    const paragraphs = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-document-paragraph]') ?? []);
    const readingLine = Math.min(160, window.innerHeight * 0.24);
    const visible = paragraphs.filter(element => !element.closest('[aria-hidden="true"]'));
    const words = visible.flatMap(element => Array.from(element.querySelectorAll<HTMLElement>('[data-document-word]')))
      .filter(element => !element.closest('[aria-hidden="true"]'));
    for (const element of words) {
      layoutAnimations.current.get(element)?.cancel();
      layoutAnimations.current.delete(element);
    }
    const positions = new Map<HTMLElement, { left: number; top: number }>();
    for (const element of words) {
      const box = element.getBoundingClientRect();
      if (box.bottom >= -window.innerHeight && box.top <= window.innerHeight * 2) positions.set(element, { left: box.left, top: box.top });
    }
    beforeLayout.current = positions;
    const pointed = typeof x === 'number' && typeof y === 'number'
      ? document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-document-word], [data-document-paragraph]')
      : null;
    const readingWord = pointed && root.current?.contains(pointed) && !pointed.closest('[aria-hidden="true"]')
      ? pointed : words.find(element => element.getBoundingClientRect().bottom > readingLine);
    const paragraph = readingWord?.closest<HTMLElement>('[data-document-paragraph]')
      ?? visible.find(element => element.getBoundingClientRect().bottom > readingLine);
    const element = readingWord ?? paragraph ?? root.current?.querySelector<HTMLElement>('.progressive-document__intro');
    const before = new Set<string>();
    if (paragraph) {
      for (const previous of paragraphs) {
        if (previous === paragraph) break;
        before.add(previous.dataset.documentParagraph ?? previous.id);
      }
    }
    anchor.current = element ? { element, top: element.getBoundingClientRect().top } : null;
    setInstantBefore(before);
  }, []);
  const changeDepth = useCallback((next: number, x?: number, y?: number, fixedAnchor?: HTMLElement) => {
    const target = Math.max(0, Math.min(next, data.maxDepth));
    if (target === currentDepth.current) return;
    rememberAnchor(x, y);
    if (fixedAnchor) anchor.current = { element: fixedAnchor, top: fixedAnchor.getBoundingClientRect().top };
    currentDepth.current = target;
    setDepth(currentDepth.current);
  }, [data.maxDepth, rememberAnchor]);

  useLayoutEffect(() => {
    if (depth < 2 && anchor.current) {
      window.scrollTo({ top: 0, behavior: 'instant' });
      observedScrollY.current = 0;
      anchor.current = null;
      beforeLayout.current = null;
      return;
    }
    const savedAnchor = anchor.current;
    if (savedAnchor && savedAnchor.element.isConnected && !savedAnchor.element.closest('[aria-hidden="true"]')) {
      const shift = savedAnchor.element.getBoundingClientRect().top - savedAnchor.top;
      if (Math.abs(shift) > 1) {
        window.scrollBy({ top: shift, behavior: 'instant' });
        observedScrollY.current = window.scrollY;
      }
      anchor.current = null;
    }
    const oldTops = beforeLayout.current;
    beforeLayout.current = null;
    if (!oldTops || !savedAnchor) return;
    let cancelRead = () => {};
    cancelRead = readLayoutTogether(() => {
      const style = root.current ? window.getComputedStyle(root.current) : null;
      const durationToken = style?.getPropertyValue('--document-arrival').trim() ?? '';
      const amount = Number.parseFloat(durationToken);
      const duration = durationToken.endsWith('ms') ? amount : durationToken.endsWith('s') ? amount * 1000 : 0;
      const easing = style?.getPropertyValue('--document-ease').trim() || 'ease-out';
      if (!(duration > 0) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const movements = Array.from(oldTops).flatMap(([element, oldBox]) => {
        const paragraphId = element.closest<HTMLElement>('[data-document-paragraph]')?.dataset.documentParagraph;
        if (!element.isConnected || element.closest('[aria-hidden="true"]') || (paragraphId && instantBefore.has(paragraphId))) return [];
        const box = element.getBoundingClientRect();
        if (box.bottom < -window.innerHeight || box.top > window.innerHeight * 2) return [];
        const dx = oldBox.left - box.left, dy = oldBox.top - box.top;
        return Math.abs(dx) < 1 && Math.abs(dy) < 1 ? [] : [{ element, dx, dy }];
      });
      // Finish every shared layout read before writing animation state.
      queueMicrotask(() => {
        for (const { element, dx, dy } of movements) {
          if (!element.isConnected) continue;
          const animation = element.animate(
            [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
            { duration, easing, fill: 'both' },
          );
          layoutAnimations.current.set(element, animation);
          animation.onfinish = () => {
            animation.cancel();
            layoutAnimations.current.delete(element);
          };
        }
      });
    });
    return () => cancelRead();
  }, [depth, localVisibility, instantBefore]);

  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const revealForReducedMotion = () => { if (motion.matches) changeDepth(data.maxDepth); };
    setReady(true);
    revealForReducedMotion();
    motion.addEventListener('change', revealForReducedMotion);
    return () => motion.removeEventListener('change', revealForReducedMotion);
  }, [changeDepth, data.maxDepth]);

  // A compact introduction must not reveal itself merely because its markers
  // fit on screen. The first two deliberate downward scrolls expose the suffix
  // and complete skeleton; subsequent scrolling only reads that document.
  useEffect(() => {
    if (!ready) return;
    observedScrollY.current = window.scrollY;
    const onScroll = () => {
      const previous = observedScrollY.current ?? window.scrollY;
      observedScrollY.current = window.scrollY;
      const distance = window.scrollY - previous;
      if (currentDepth.current >= 2 || distance <= 0 || window.scrollY < 16) return;
      changeDepth(distance > window.innerHeight * 0.22 ? 2 : currentDepth.current + 1);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [ready, changeDepth]);

  // Only deliberate modified-wheel input or a two-finger pinch changes depth.
  // The listener lives on this article; ordinary wheel movement remains page scroll.
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const distance = (touches: TouchList) => Math.hypot(
      touches[0].clientX - touches[1].clientX,
      touches[0].clientY - touches[1].clientY,
    );
    const insideArticle = (touch: Touch) => {
      const rect = element.getBoundingClientRect();
      return touch.clientX >= rect.left && touch.clientX <= rect.right
        && touch.clientY >= rect.top && touch.clientY <= rect.bottom;
    };
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const now = performance.now();
      if (now - lastWheelAt.current > 220) wheelAccumulation.current = 0;
      lastWheelAt.current = now;
      wheelAccumulation.current += event.deltaY;
      if (Math.abs(wheelAccumulation.current) > 62) {
        const direction = wheelAccumulation.current < 0 ? 1 : -1;
        wheelAccumulation.current = 0;
        changeDepth(currentDepth.current + direction, event.clientX, event.clientY);
      }
    };
    const onTouchStart = (event: TouchEvent) => {
      touchStartDistance.current = event.touches.length === 2
        && insideArticle(event.touches[0]) && insideArticle(event.touches[1])
        ? distance(event.touches)
        : null;
    };
    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 2 || touchStartDistance.current === null) return;
      if (!insideArticle(event.touches[0]) || !insideArticle(event.touches[1])) {
        touchStartDistance.current = null;
        return;
      }
      event.preventDefault();
      const currentDistance = distance(event.touches);
      const ratio = currentDistance / touchStartDistance.current;
      if (ratio > 1.18 || ratio < 0.84) {
        const x = (event.touches[0].clientX + event.touches[1].clientX) / 2;
        const y = (event.touches[0].clientY + event.touches[1].clientY) / 2;
        changeDepth(currentDepth.current + (ratio > 1.18 ? 1 : -1), x, y);
        touchStartDistance.current = currentDistance;
      }
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) touchStartDistance.current = null;
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchmove', onTouchMove, { passive: false });
    element.addEventListener('touchend', onTouchEnd, { passive: true });
    element.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchmove', onTouchMove);
      element.removeEventListener('touchend', onTouchEnd);
      element.removeEventListener('touchcancel', onTouchEnd);
      wheelAccumulation.current = 0;
      touchStartDistance.current = null;
    };
  }, [changeDepth]);

  const toggleGroup = (groupId: string, visible: boolean) => {
    rememberAnchor();
    setLocalVisibility(previous => ({ ...previous, [groupId]: !visible }));
  };

  return (
    <article className="progressive-document" ref={root} data-depth={depth} data-ready={ready ? '' : undefined}>
      <a className="progressive-document__read-all" href={`#${instanceId}-${data.paragraphs[0]?.id ?? ''}`} onClick={() => {
        rememberAnchor();
        setLocalVisibility({});
        changeDepth(data.maxDepth);
      }}>{data.words.readFull}</a>
      <header className="progressive-document__intro">
        <h1 className="progressive-document__promise">
          {data.hero.base}
          <span id={`${instanceId}-society`} className="progressive-document__suffix"
            data-visible={depth >= data.hero.suffixMinDepth ? '' : undefined}
            aria-hidden={depth < data.hero.suffixMinDepth}>{data.hero.suffix}</span>
          {data.hero.punctuation}{' '}
          <Button variant="outline" size="lg" className="coss-ui progressive-document__hinge progressive-document__hero-hinge"
            data-kind="mark" aria-controls={`${instanceId}-${depth < data.hero.suffixMinDepth ? 'society' : 'argument'}`}
            aria-expanded={depth < data.hero.suffixMinDepth ? depth >= data.hero.suffixMinDepth : depth >= 2}
            aria-label={depth >= data.narrativeDepth
              ? `${data.words.collapse}: ${data.title}`
              : `${data.words.expand}: ${depth < data.hero.suffixMinDepth ? data.hero.suffix.trim() : data.title}`}
            onClick={event => {
              setLocalVisibility({});
              changeDepth(depth >= data.narrativeDepth ? 2 : depth + 1, undefined, undefined, event.currentTarget.closest('h1') ?? event.currentTarget);
            }}>
            <ArrowRight aria-hidden="true" className="progressive-document__marker" />
          </Button>
        </h1>
      </header>
      <Reveal open={depth >= 2} className="progressive-document__reveal">
        <div id={`${instanceId}-argument`} className="progressive-document__argument">
          {data.paragraphs.map((paragraph, paragraphIndex) => {
            const first = paragraphDepth(paragraph);
            const visible = depth >= first;
            const groups = partGroups(paragraph);
            const groupStates = groups.map((group, groupIndex) => {
              const isDetail = group.minDepth > first;
              const priorDetails = groups.slice(0, groupIndex).filter(previous => previous.minDepth > first);
              const visibleByDepth = (part: typeof group) => depth >= part.minDepth && (part.minDepth === first || depth > data.narrativeDepth);
              const available = !isDetail || priorDetails.every(previous => localVisibility[previous.id] ?? visibleByDepth(previous));
              const groupVisible = available && (localVisibility[group.id] ?? visibleByDepth(group));
              return { group, isDetail, available, groupVisible, markerVisible: isDetail && available };
            });
            return (
              <p key={paragraph.id} id={`${instanceId}-${paragraph.id}`} data-document-paragraph={paragraph.id}
                data-motion={instantBefore.has(paragraph.id) ? 'instant' : undefined}
                className="progressive-document__paragraph" hidden={!visible} aria-hidden={!visible} inert={!visible}>
                {groupStates.map(({ group, isDetail, available, groupVisible, markerVisible }, groupIndex) => {
                  const hasEarlierInlineContent = groupStates.slice(0, groupIndex)
                    .some(previous => previous.groupVisible || previous.markerVisible);
                  const groupSummary = group.parts.map(part => part.text).join(' ').slice(0, 160);
                  const accessibleAction = (groupVisible ? data.words.collapseAccessible : data.words.expandAccessible)
                    .replace('{n}', `${paragraphIndex + 1}: ${groupSummary}`);
                  const groupDomId = `${instanceId}-${group.id}-group`;
                  const RoleMark = group.kind === 'principle' ? Diamond
                    : group.kind === 'framework' ? Square
                      : group.kind === 'exercise' || group.kind === 'example' ? Asterisk
                        : Circle;
                  return (
                    <span key={group.id} className="progressive-document__inline-piece">
                      {hasEarlierInlineContent && (groupVisible || markerVisible) ? ' ' : null}
                      {markerVisible && (
                        <Button variant="outline" size="lg" className="coss-ui progressive-document__hinge"
                          data-kind={group.kind} aria-controls={groupDomId} aria-expanded={groupVisible}
                          aria-label={accessibleAction}
                          onClick={() => toggleGroup(group.id, groupVisible)}>
                          <RoleMark aria-hidden="true" className="progressive-document__role-mark" />
                          <ArrowRight aria-hidden="true" className="progressive-document__marker" />
                        </Button>
                      )}
                      <span id={groupDomId} aria-hidden={!groupVisible} className="progressive-document__part-group">
                        {group.parts.map((part, partIndex) => (
                          <span key={part.id} id={`${instanceId}-${part.id}`} data-kind={part.kind} data-min-depth={part.minDepth}
                            data-visible={groupVisible ? '' : undefined} aria-hidden={!groupVisible}
                            className="progressive-document__part">
                            {groupVisible && partIndex > 0 ? ' ' : null}{passageWords(part)}
                          </span>
                        ))}
                      </span>
                    </span>
                  );
                })}
              </p>
            );
          })}
        </div>
      </Reveal>
    </article>
  );
}
