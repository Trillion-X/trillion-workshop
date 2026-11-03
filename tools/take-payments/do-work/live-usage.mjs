// Required native-owner API, retained from verified main.
export async function usageReadings({ day, names, storedBytes, workDollars }) {
  const readers = {
    'stored-bytes': () => storedBytes(),
    'work-cost': async () => {
      const dollars = await workDollars(day);
      if (!Number.isFinite(dollars) || dollars < 0) throw new Error('The work of that day could not be priced.');
      return Math.round(dollars * 100_000);
    },
  };
  const read = {};
  for (const name of names) {
    if (!readers[name]) throw new Error(`No reader answers the usage reading ${name}.`);
    read[name] = await readers[name]();
  }
  return read;
}
