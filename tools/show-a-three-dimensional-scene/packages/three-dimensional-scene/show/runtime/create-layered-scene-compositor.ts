export type CinematicPlate = {
  id: string;
  source: string;
  alt: string;
  range: readonly [number, number];
  camera: {
    from: { x: number; y: number; scale: number };
    to: { x: number; y: number; scale: number };
  };
};

export type LayeredSceneCompositor = { update(): void; dispose(): void };

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const mix = (from: number, to: number, t: number) => from + (to - from) * t;
const smoothstep = (value: number) => {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
};

function plateOpacity(progress: number, index: number, plates: readonly CinematicPlate[]) {
  const [start, end] = plates[index].range;
  const fade = Math.min(0.085, Math.max(0.035, (end - start) * 0.24));
  const enter = index === 0 ? 1 : smoothstep((progress - start) / fade);
  const leave = index === plates.length - 1 ? 1 : 1 - smoothstep((progress - (end - fade)) / fade);
  return clamp(enter * leave);
}

function createAtmosphereCanvas(reducedMotion: boolean) {
  const canvas = document.createElement('canvas');
  canvas.className = 'scene-atmosphere';
  canvas.setAttribute('aria-hidden', 'true');
  const context = canvas.getContext('2d');
  const particles = Array.from({ length: reducedMotion ? 0 : 92 }, (_, index) => ({
    x: ((index * 73) % 997) / 997,
    y: ((index * 193) % 991) / 991,
    speed: 0.00006 + (index % 9) * 0.000012,
    length: 9 + (index % 13) * 1.7,
    alpha: 0.05 + (index % 7) * 0.018,
  }));
  let width = 0; let height = 0; let frame = 0; let last = performance.now(); let disposed = false;
  const resize = () => {
    const ratio = Math.min(devicePixelRatio || 1, 1.5);
    const rect = canvas.getBoundingClientRect();
    width = Math.max(1, Math.round(rect.width)); height = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    context?.setTransform(ratio, 0, 0, ratio, 0, 0);
  };
  const draw = (now: number) => {
    if (disposed || !context) return;
    const delta = Math.min(48, now - last); last = now;
    if (canvas.width === 0 || canvas.clientWidth !== width || canvas.clientHeight !== height) resize();
    context.clearRect(0, 0, width, height);
    context.lineWidth = 0.7;
    for (const particle of particles) {
      particle.y = (particle.y + particle.speed * delta) % 1.08;
      const x = particle.x * width; const y = particle.y * height;
      const gradient = context.createLinearGradient(x, y, x - 3, y + particle.length);
      gradient.addColorStop(0, `rgba(223,230,219,0)`);
      gradient.addColorStop(1, `rgba(223,230,219,${particle.alpha})`);
      context.strokeStyle = gradient; context.beginPath(); context.moveTo(x, y); context.lineTo(x - 3, y + particle.length); context.stroke();
    }
    frame = requestAnimationFrame(draw);
  };
  if (!reducedMotion) frame = requestAnimationFrame(draw);
  return { canvas, dispose: () => { disposed = true; if (frame) cancelAnimationFrame(frame); } };
}

export function createLayeredSceneCompositor(options: {
  container: HTMLElement;
  driverElement: HTMLElement;
  plates: readonly CinematicPlate[];
  reducedMotion: boolean;
}): LayeredSceneCompositor {
  const root = document.createElement('div');
  root.className = 'scene-compositor';
  root.setAttribute('aria-hidden', 'true');
  const plateElements = options.plates.map((plate) => {
    const layer = document.createElement('div'); layer.className = 'scene-plate'; layer.dataset.plateId = plate.id;
    const image = document.createElement('img'); image.src = plate.source; image.alt = ''; image.decoding = 'async'; image.draggable = false;
    const foreground = image.cloneNode() as HTMLImageElement; foreground.className = 'scene-plate-foreground';
    layer.append(image, foreground); root.append(layer);
    return { layer, image, foreground };
  });
  const light = document.createElement('div'); light.className = 'scene-volumetric-light'; root.append(light);
  const atmosphere = createAtmosphereCanvas(options.reducedMotion); root.append(atmosphere.canvas);
  const grade = document.createElement('div'); grade.className = 'scene-grade'; root.append(grade);
  options.container.prepend(root);

  let frame = 0; let disposed = false;
  const render = () => {
    frame = 0; if (disposed) return;
    const rect = options.driverElement.getBoundingClientRect();
    const travel = Math.max(1, rect.height - innerHeight);
    const progress = options.reducedMotion ? 0 : clamp(-rect.top / travel);
    root.style.setProperty('--scene-progress', String(progress));
    plateElements.forEach(({ layer, image, foreground }, index) => {
      const plate = options.plates[index];
      const [start, end] = plate.range; const local = smoothstep((progress - start) / Math.max(0.001, end - start));
      const x = mix(plate.camera.from.x, plate.camera.to.x, local);
      const y = mix(plate.camera.from.y, plate.camera.to.y, local);
      const scale = mix(plate.camera.from.scale, plate.camera.to.scale, local);
      layer.style.opacity = String(options.reducedMotion ? (index === 0 ? 1 : 0) : plateOpacity(progress, index, options.plates));
      image.style.transform = `translate3d(${x}%,${y}%,0) scale(${scale})`;
      foreground.style.transform = `translate3d(${x * 1.5}%,${y * 1.25 + 1.2}%,0) scale(${scale * 1.045})`;
    });
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };
  addEventListener('scroll', schedule, { passive: true }); addEventListener('resize', schedule, { passive: true });
  render();
  return { update: schedule, dispose: () => {
    if (disposed) return; disposed = true; if (frame) cancelAnimationFrame(frame);
    removeEventListener('scroll', schedule); removeEventListener('resize', schedule); atmosphere.dispose(); root.remove();
  } };
}
