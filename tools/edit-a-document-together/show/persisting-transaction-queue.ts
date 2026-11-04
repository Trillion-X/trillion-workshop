/**
 * One Composition surface owns one durable mutation stream.  A caller receives
 * its own promise, while the tail always absorbs failure so a rejected write
 * cannot strand later user edits behind a permanently rejected promise.
 */
export interface PersistingTransactionQueue {
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
}

export function createPersistingTransactionQueue(): PersistingTransactionQueue {
  let tail: Promise<void> = Promise.resolve();

  return {
    enqueue<T>(operation: () => Promise<T>): Promise<T> {
      const result = tail.then(operation);
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}
