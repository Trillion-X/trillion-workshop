const moving = d.map((_, i) => [d[i - 1], d[i], d[i + 1]].some((v) => v > STILL && v <= CUT));
const holds = [];
for (let i = 0, run = 0, s = 0; i <= moving.length; i++) {
  if (i < moving.length && !moving[i] && d[i] <= CUT) { if (!run) s = i; run++; }
  else { if (run) holds.push([run / p.fps, s / p.fps]); run = 0; }
}
holds.sort((a, b) => b[0] - a[0]);
console.log(holds.slice(0, 12).map(([h, s]) => h.toFixed(2) + 's@' + s.toFixed(2)).join('  '));
