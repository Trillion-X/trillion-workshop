// A hybrid logical clock for ordering events from independent devices and agents.
// Physical time keeps unrelated events approximately chronological; the logical
// counter carries causality when clocks tie or a remote event arrives ahead.
const valid = value => value && typeof value === 'object'
  && Number.isSafeInteger(value.wall_ms) && value.wall_ms >= 0 && value.wall_ms <= 8_640_000_000_000_000
  && Number.isSafeInteger(value.logical) && value.logical >= 0
  && typeof value.device_id === 'string' && value.device_id.trim().length > 0;

export function isHybridTimestamp(value) { return valid(value); }

function wallTime(now) {
  const wall = Number(now);
  if (!Number.isSafeInteger(wall) || wall < 0) throw new TypeError('now must be a non-negative safe integer in milliseconds');
  return wall;
}

function deviceId(device) {
  if (typeof device !== 'string' || !device.trim()) throw new TypeError('device_id must be a non-empty string');
  return device.trim();
}

function priorOf(value) {
  if (value == null) return null;
  if (!valid(value)) throw new TypeError('clock must contain wall_ms, logical, and device_id');
  return value;
}

function nextLogical(value) {
  if (value >= Number.MAX_SAFE_INTEGER) throw new RangeError('hybrid clock logical count is exhausted at this physical time');
  return value + 1;
}

/** Stamp a locally-created event. The returned stamp is also the next local state. */
export function tickHybridClock(previous, now, device) {
  const prior = priorOf(previous);
  const wall = wallTime(now);
  const local = deviceId(device);
  if (!prior || wall > prior.wall_ms) return { wall_ms: wall, logical: 0, device_id: local };
  return { wall_ms: prior.wall_ms, logical: nextLogical(prior.logical), device_id: local };
}

/** Merge a received event into local state; callers keep the received stamp on that event. */
export function receiveHybridClock(localState, received, now, device) {
  const local = priorOf(localState);
  const remote = priorOf(received);
  const wall = Math.max(wallTime(now), local?.wall_ms ?? 0, remote?.wall_ms ?? 0);
  const localAtWall = local?.wall_ms === wall;
  const remoteAtWall = remote?.wall_ms === wall;
  let logical = 0;
  if (localAtWall && remoteAtWall) logical = nextLogical(Math.max(local.logical, remote.logical));
  else if (localAtWall) logical = nextLogical(local.logical);
  else if (remoteAtWall) logical = nextLogical(remote.logical);
  return { wall_ms: wall, logical, device_id: deviceId(device) };
}

/** Total deterministic order; device_id breaks ties between concurrent events. */
export function compareHybridTimestamps(left, right) {
  if (!valid(left) || !valid(right)) throw new TypeError('both values must be hybrid timestamps');
  const leftDevice = encodeURIComponent(left.device_id);
  const rightDevice = encodeURIComponent(right.device_id);
  return left.wall_ms - right.wall_ms
    || left.logical - right.logical
    || (leftDevice < rightDevice ? -1 : leftDevice > rightDevice ? 1 : 0);
}

/** A lexically sortable prefix for append-only record IDs and indexes. */
export function hybridTimestampKey(value) {
  if (!valid(value)) throw new TypeError('value must be a hybrid timestamp');
  return `${String(value.wall_ms).padStart(16, '0')}:${String(value.logical).padStart(12, '0')}:${encodeURIComponent(value.device_id)}`;
}
