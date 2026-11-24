import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  database: undefined as DatabaseSync | undefined,
}));
vi.mock('@main/database/client', () => ({
  getDatabase: () => ({ $client: fixture.database }),
}));

import {
  getHistoryUsageCalendar,
  recordHistoryUsage,
} from '@main/services/history/historyUsage';

beforeEach(() => {
  const database = new DatabaseSync(':memory:');
  fixture.database = database;
  database.exec(
    "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT); INSERT INTO projects VALUES ('p', '历史期中卷');",
  );
});

afterEach(() => {
  fixture.database?.close();
  vi.restoreAllMocks();
});

it('counts local days, filters requests and preserves missing usage separately from a measured zero', () => {
  const now = vi.spyOn(Date, 'now');
  now.mockReturnValue(new Date(2026, 10, 23, 23, 55).getTime());
  const item = {
    projectId: 'p',
    model: '视觉模型',
    operation: '图片阅卷',
    durationMs: 45,
  } as const;
  recordHistoryUsage({
    ...item,
    outcome: 'success',
    rawUsage: { input_tokens: 0, output_tokens: 0 },
  });
  recordHistoryUsage({ ...item, outcome: 'error', failure: '等待超时' });
  recordHistoryUsage({ ...item, outcome: 'success', cacheHit: true });
  recordHistoryUsage({
    ...item,
    operation: '其他操作',
    outcome: 'success',
    rawUsage: { total_tokens: 99 },
  });
  now.mockReturnValue(new Date(2026, 10, 24, 0, 5).getTime());
  recordHistoryUsage({
    ...item,
    outcome: 'success',
    rawUsage: { total_tokens: 100 },
  });

  const result = getHistoryUsageCalendar({
    fromDate: '2026-11-23',
    toDate: '2026-11-23',
    detailDate: '2026-11-23',
    projectId: 'p',
    model: '视觉模型',
    operation: '图片阅卷',
  });
  expect(result.totals).toMatchObject({
    requests: 2,
    successes: 1,
    failures: 1,
    cacheHits: 1,
    usageReported: 1,
    totalTokens: 0,
  });
  expect(result.days).toMatchObject([{ date: '2026-11-23', totalTokens: 0 }]);
  expect(result.projects).toEqual([{ id: 'p', name: '历史期中卷' }]);
  expect(result.events).toMatchObject([
    { cacheHit: true, totalTokens: null },
    { outcome: 'error', failure: '等待超时', totalTokens: null },
    { outcome: 'success', totalTokens: 0 },
  ]);
  const unknown = getHistoryUsageCalendar({
    fromDate: '2026-11-22',
    toDate: '2026-11-22',
  });
  expect(unknown.totals).toMatchObject({
    requests: 0,
    usageReported: 0,
    totalTokens: null,
  });
});

it('upgrades the ledger and reports provider cache reads separately from local result-cache hits', () => {
  fixture.database!.exec(`
    CREATE TABLE history_usage_events (
      id INTEGER PRIMARY KEY, timestamp INTEGER NOT NULL, project_id TEXT,
      model TEXT NOT NULL, operation TEXT NOT NULL, duration_ms INTEGER NOT NULL,
      outcome TEXT NOT NULL, failure TEXT, cache_hit INTEGER NOT NULL,
      input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER
    );
  `);
  vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 10, 23, 12).getTime());
  const event = {
    model: '视觉',
    operation: '图片阅卷',
    durationMs: 20,
    outcome: 'success',
  } as const;
  recordHistoryUsage(event);
  recordHistoryUsage({
    ...event,
    rawUsage: { input_tokens_details: { cached_tokens: 0 } },
  });
  recordHistoryUsage({
    ...event,
    rawUsage: { prompt_tokens_details: { cached_tokens: 70 } },
  });
  recordHistoryUsage({ ...event, rawUsage: { cache_read_input_tokens: 30 } });
  recordHistoryUsage({
    ...event,
    cacheHit: true,
    rawUsage: { cache_read_input_tokens: 90 },
  });
  const result = getHistoryUsageCalendar({
    fromDate: '2026-11-23',
    toDate: '2026-11-23',
    detailDate: '2026-11-23',
  });
  expect(result.totals).toMatchObject({
    cacheReadTokens: 100,
    cacheHits: 1,
    requests: 4,
  });
  expect(result.days[0].cacheReadTokens).toBe(100);
  expect(result.events.map(({ cacheReadTokens }) => cacheReadTokens)).toEqual([
    null,
    30,
    70,
    0,
    null,
  ]);
});
