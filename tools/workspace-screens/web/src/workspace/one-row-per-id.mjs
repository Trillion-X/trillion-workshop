// Keep the last row for each identity without changing the first-seen order.
// A tool screen that replaces a shipped screen intentionally has the same id;
// both the browser and the account sidebar must let that tool take its place.
export function oneRowPerId(rows) {
  return [...new Map(rows.map(row => [row.id, row])).values()];
}
