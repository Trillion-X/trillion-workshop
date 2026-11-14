import { contextScene } from '../../M024/lesson/lesson-model.mjs';
import * as K from '../../../../parts/ui/show/anatomy/iso-kit.mjs';

const NOTEBOOK_PAPER = [[-18, 58, 73.8], [18, 58, 73.8], [18, 83, 73.8], [-18, 83, 73.8]];

function withManualNotebookTarget(scene, label) {
  const anchor = scene.state?.notebookScreen;
  if (!Array.isArray(anchor) || anchor.length !== 2 || !anchor.every(Number.isFinite)) {
    throw new TypeError('The seated reader scene must expose its notebook page anchor.');
  }
  const source = scene.svg;
  const bodyStart = source.indexOf(String.fromCharCode(62)) + 1;
  const bodyEnd = source.lastIndexOf(String.fromCharCode(60));
  const viewBox = source.slice(0, bodyStart).match(/\bviewBox="0 0 ([\d.]+) ([\d.]+)"/);
  if (bodyStart <= 0 || bodyEnd < bodyStart || !viewBox) {
    throw new TypeError('The seated reader scene must be a complete Anatomy figure.');
  }

  const [x, y] = anchor;
  const targetMark = K.groupSvg([
    K.lineSvg(K.pathOf(K.circleRing(x, y, 10), true), { tone: 'blue' }),
    K.lineSvg(K.pathOf([[x - 13, y], [x + 13, y]]), { tone: 'blue' }),
    K.lineSvg(K.pathOf([[x, y - 13], [x, y + 13]]), { tone: 'blue' }),
  ], { 'data-part': 'm036-manual-target' });
  const svg = K.figureSvg({
    width: Number(viewBox[1]), height: Number(viewBox[2]), label,
    body: [source.slice(bodyStart, bodyEnd), targetMark],
  });
  return { ...scene, svg, manualTarget: { anchor, projection: scene.state.projection } };
}

export function readerScene({ label, manualTarget = false } = {}) {
  const scene = contextScene({ experience: 'puzzle', label });
  return manualTarget ? withManualNotebookTarget(scene, label) : scene;
}

export const NOTEBOOK_PAPER_CORNERS = NOTEBOOK_PAPER;
