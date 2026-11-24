import { getDatabase } from '@main/database/client';
import type { OpticalMark } from '@preload/history';
import type { gradeHistoryImage } from './historyModels';

type Images = Awaited<ReturnType<typeof gradeHistoryImage>>;
type CachedResult =
  | { kind: 'written'; value: Images }
  | { kind: 'choice'; value: OpticalMark };

function cache() {
  const db = getDatabase().$client;
  db.exec(`CREATE TABLE IF NOT EXISTS history_result_cache (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    cache_key TEXT NOT NULL, result_json TEXT NOT NULL,
    PRIMARY KEY(project_id, cache_key)
  )`);
  return db;
}

export function findCachedResult(
  projectId: string,
  key: string,
): CachedResult | undefined {
  try {
    const row = cache()
      .prepare(
        'SELECT result_json FROM history_result_cache WHERE project_id = ? AND cache_key = ?',
      )
      .get(projectId, key) as { result_json: string } | undefined;
    return row ? (JSON.parse(row.result_json) as CachedResult) : undefined;
  } catch {
    return undefined;
  }
}

export function saveCachedResult(
  projectId: string,
  key: string,
  result: CachedResult,
) {
  try {
    cache()
      .prepare(
        `INSERT INTO history_result_cache(project_id, cache_key, result_json)
      VALUES (?, ?, ?) ON CONFLICT(project_id, cache_key)
      DO UPDATE SET result_json=excluded.result_json`,
      )
      .run(projectId, key, JSON.stringify(result));
  } catch (error) {
    console.warn('无法保存评分缓存', error);
  }
}
