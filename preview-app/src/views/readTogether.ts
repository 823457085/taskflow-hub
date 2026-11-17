type ReadValues<T extends readonly unknown[]> = { -readonly [K in keyof T]: Awaited<T[K]> };

export async function readTogether<const T extends readonly unknown[]>(reads: T): Promise<ReadValues<T>> {
  const results = await Promise.allSettled(reads);
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  for (const status of [401, 403]) {
    const failure = failures.find(({ reason }) => reason !== null && typeof reason === 'object' && reason.status === status);
    if (failure) throw failure.reason;
  }
  if (failures.length) throw failures[0].reason;
  return results.map(result => (result as PromiseFulfilledResult<unknown>).value) as ReadValues<T>;
}
