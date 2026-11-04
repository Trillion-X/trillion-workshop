// Pure board merge shared by resource commitments and independent creation rooms.
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isNameList = value => Array.isArray(value) && value.every(entry => typeof entry === 'string');
export function mergeBoardValue(base, mine, current) {
  if (same(mine, base)) return current;
  if (same(current, base)) return mine;
  if (isObject(mine) && isObject(current)) {
    if (mine.status === 'deleted') return mine;
    if (current.status === 'deleted') return current;
    const from = isObject(base) ? base : {};
    const merged = {};
    for (const key of new Set([...Object.keys(current), ...Object.keys(mine)])) {
      const value = mergeBoardValue(from[key], mine[key], current[key]);
      if (value !== undefined) merged[key] = value;
    }
    return merged;
  }
  if (isNameList(mine) && isNameList(current)) {
    const was = new Set(isNameList(base) ? base : []);
    const now = new Set(current);
    const kept = new Set(mine);
    const merged = mine.filter(name => now.has(name) || !was.has(name));
    for (const name of current) if (!kept.has(name) && !was.has(name)) merged.push(name);
    return [...new Set(merged)];
  }
  return mine;
}

