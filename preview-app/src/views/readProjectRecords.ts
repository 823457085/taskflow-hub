import { readTogether } from './readTogether';

export async function readProjectRecords<T>(projectIds: readonly string[], load: (projectId: string) => Promise<T>): Promise<T[]> {
  const records: T[] = [];
  const batchSize = 4;
  for (let start = 0; start < projectIds.length; start += batchSize) {
    records.push(...await readTogether(projectIds.slice(start, start + batchSize).map(load)));
  }
  return records;
}
