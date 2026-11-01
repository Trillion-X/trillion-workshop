// The time-zone name check used by the account's look plan reader.
export function timeZoneName(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.trim() });
    return value.trim();
  } catch {
    return null;
  }
}
