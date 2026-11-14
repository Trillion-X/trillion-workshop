import { describe, expect, it } from 'vitest';
import { BOARD_TEMPLATES } from './board-templates';
import { applyTemplate, type TemplateItem } from '../read-data/board-template-apply';
import { parseBoardTemplate } from '../read-data/collection-store';
import { boardIndexRef, boardRootRef, readItems } from '../read-data/group-board-model';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';

function mintSeq() {
  let n = 0;
  return () => `bt-mint-${n++}`;
}

describe('BOARD_TEMPLATES', () => {
  it('every template has a unique id, a name, and at least one item', () => {
    const ids = BOARD_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of BOARD_TEMPLATES) {
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.items.length).toBeGreaterThan(0);
    }
  });

  // Built-in templates bypass parseBoardTemplate (they are hand-authored constants fed straight to
  // applyTemplate), so the parse-gate invariants that protect SAVED collections (unique item ids —
  // Codex F4; valid metadata — F2) do NOT protect the built-ins. This runs every built-in through
  // the SAME gate, so an author who ever adds a template with duplicate item ids fails CLOSED here
  // instead of at runtime (applyTemplate mints one member per id → addMember would throw / overwrite).
  it('every built-in template satisfies the parse-gate invariants (unique item ids across the whole tree — F4)', () => {
    for (const t of BOARD_TEMPLATES) {
      expect(parseBoardTemplate(t), t.id).not.toBeNull();
    }
  });

  // Codex F1/F5 at the built-in layer: a connector whose endpoint (from/to OR extra.fromMemberId/
  // toMemberId) names an id that isn't a real item in the SAME template is a dangling arrow — applyTemplate
  // drops it (fail-closed). This asserts NO built-in ships such a dangling connector, so every arrow a
  // template promises actually renders on the applied board (sketch-whiteboard uses the extra encoding).
  it('every built-in connector references real endpoints — applied boards keep all their arrows (F1/F5)', () => {
    const localIds = (items: readonly TemplateItem[], acc = new Set<string>()): Set<string> => {
      for (const it of items) {
        acc.add(it.id);
        if (it.children) localIds(it.children, acc);
      }
      return acc;
    };
    const connectorsOf = (items: readonly TemplateItem[], acc: TemplateItem[] = []): TemplateItem[] => {
      for (const it of items) {
        if (it.kind === 'connector') acc.push(it);
        if (it.children) connectorsOf(it.children, acc);
      }
      return acc;
    };
    for (const t of BOARD_TEMPLATES) {
      const ids = localIds(t.items);
      const conns = connectorsOf(t.items);
      // 1) every endpoint the template author wrote resolves to a real item id
      for (const c of conns) {
        const from = c.from ?? (typeof c.extra?.fromMemberId === 'string' ? c.extra.fromMemberId : undefined);
        const to = c.to ?? (typeof c.extra?.toMemberId === 'string' ? c.extra.toMemberId : undefined);
        expect(from, `${t.id} connector ${c.id} from`).toBeDefined();
        expect(to, `${t.id} connector ${c.id} to`).toBeDefined();
        expect(ids.has(from as string), `${t.id} from ${from}`).toBe(true);
        expect(ids.has(to as string), `${t.id} to ${to}`).toBe(true);
      }
      // 2) end-to-end: applying keeps EVERY connector (none silently dropped as dangling)
      const g = applyTemplate(emptyGraph(), boardIndexRef('bt'), { template: t, newBoardId: 'BT', newMemberId: 'm', mint: mintSeq() });
      const placed = readItems(g, boardRootRef('BT'));
      const placedConnectors = placed.filter((i) => typeof i.extra?.fromMemberId === 'string' || typeof i.extra?.toMemberId === 'string' || i.kind === 'connector');
      expect(placedConnectors.length, `${t.id} kept all connectors`).toBe(conns.length);
    }
  });

  it('cont.26 (E5) — the "Infra we build on" template ships the SKETCH look as pure DATA', () => {
    const infra = BOARD_TEMPLATES.find((t) => t.id === 'infra-stack');
    expect(infra).toBeTruthy();
    const boxes = infra!.items.filter((i) => ['convex', 'aws', 'metal'].includes(i.id));
    expect(boxes.length).toBe(3);
    // Each platform box carries the cont.26 per-item sketch appearance — pencil border + handwritten
    // font — with ZERO template-engine change (per-item extra wins at the item cascade tier).
    for (const b of boxes) {
      expect(Number(b.extra?.borderRoughness)).toBeGreaterThan(0);
      expect(String(b.extra?.fontFamily)).toContain('Comic');
    }
    // The stack reads top→bottom by abstraction: row 1 (managed) above row 2 (cloud) above metal.
    const y = (id: string) => infra!.items.find((i) => i.id === id)!.y;
    expect(y('convex')).toBeLessThan(y('aws'));
    expect(y('aws')).toBeLessThan(y('metal'));
  });

  it('cont.26 — the infra + sketch-whiteboard templates carry the board-level SKETCH look (paper canvas + pencil profile)', () => {
    for (const id of ['infra-stack', 'sketch-whiteboard']) {
      const t = BOARD_TEMPLATES.find((x) => x.id === id);
      expect(t, id).toBeTruthy();
      // paper canvas + a pencil/handwritten appearance-defaults profile applied to the WHOLE board (not
      // just per item) — so opening the template yields a hand-drawn whiteboard with one click.
      expect(t!.background).toBe('paper');
      expect(t!.appearance?.connectorStrokeStyle).toBe('pencil');
      expect(t!.appearance?.borderStrokeStyle).toBe('pencil');
      expect(String(t!.appearance?.fontFamily)).toContain('Comic');
    }
  });

  it('cont.26 — the sketch-whiteboard template is a discoverable Ideation starter (name/tags/items)', () => {
    const sk = BOARD_TEMPLATES.find((t) => t.id === 'sketch-whiteboard')!;
    expect(sk.name.length).toBeGreaterThan(0);
    expect(sk.category).toBe('Ideation');
    expect(sk.tags ?? []).toContain('sketch');
    expect(sk.items.length).toBeGreaterThan(0);
    // it ships a real starter scaffold (notes + connectors), not an empty shell
    expect(sk.items.some((i) => i.kind === 'connector')).toBe(true);
  });
});
