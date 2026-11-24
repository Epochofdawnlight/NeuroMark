import { z } from 'zod';
import { getDatabase } from '@main/database/client';
import type {
  HistoryUsageCalendar,
  HistoryUsageCalendarQuery,
  HistoryUsageDay,
  HistoryUsageEvent,
  HistoryUsageTotals,
} from '@preload/contracts';

export interface HistoryUsageInput {
  projectId?: string;
  model: string;
  operation: string;
  rawUsage?: unknown;
  durationMs: number;
  outcome: 'success' | 'error';
  failure?: string;
  cacheHit?: boolean;
}

let initialized: ReturnType<typeof getDatabase>['$client'] | undefined;

function usageDatabase() {
  const database = getDatabase().$client;
  if (database !== initialized) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS history_usage_events (
        id INTEGER PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        project_id TEXT,
        model TEXT NOT NULL,
        operation TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        failure TEXT,
        cache_hit INTEGER NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        total_tokens INTEGER,
        cache_read_tokens INTEGER
      );
      CREATE INDEX IF NOT EXISTS history_usage_by_time
        ON history_usage_events (timestamp);
    `);
    const columns = database
      .prepare('PRAGMA table_info(history_usage_events)')
      .all() as { name: string }[];
    if (!columns.some(({ name }) => name === 'cache_read_tokens')) {
      database.exec(
        'ALTER TABLE history_usage_events ADD COLUMN cache_read_tokens INTEGER',
      );
    }
    initialized = database;
  }
  return database;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function cachedTokens(details: unknown): number | null {
  if (!details || typeof details !== 'object') return null;
  const fields = details as Record<string, unknown>;
  return (
    numberOrNull(fields.cached_tokens) ??
    numberOrNull(fields.cache_read_input_tokens) ??
    numberOrNull(fields.cache_read_tokens)
  );
}

export function recordHistoryUsage(input: HistoryUsageInput): void {
  try {
    const usage =
      !input.cacheHit && input.rawUsage && typeof input.rawUsage === 'object'
        ? (input.rawUsage as Record<string, unknown>)
        : {};
    const inputTokens = numberOrNull(usage.prompt_tokens ?? usage.input_tokens);
    const outputTokens = numberOrNull(
      usage.completion_tokens ?? usage.output_tokens,
    );
    const totalTokens =
      numberOrNull(usage.total_tokens) ??
      (inputTokens !== null && outputTokens !== null
        ? inputTokens + outputTokens
        : null);
    const cacheReadTokens =
      cachedTokens(usage.prompt_tokens_details) ??
      cachedTokens(usage.input_tokens_details) ??
      numberOrNull(usage.cache_read_input_tokens) ??
      numberOrNull(usage.prompt_cache_hit_tokens) ??
      numberOrNull(usage.cache_read_tokens) ??
      numberOrNull(usage.cached_tokens);
    usageDatabase()
      .prepare(
        `
      INSERT INTO history_usage_events (
        timestamp, project_id, model, operation, duration_ms, outcome, failure,
        cache_hit, input_tokens, output_tokens, total_tokens, cache_read_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        Date.now(),
        input.projectId || null,
        input.model,
        input.operation,
        Math.max(0, Math.round(input.durationMs) || 0),
        input.outcome,
        input.failure?.slice(0, 240) || null,
        input.cacheHit ? 1 : 0,
        inputTokens,
        outputTokens,
        totalTokens,
        cacheReadTokens,
      );
  } catch {
    // A local telemetry write must not interrupt a grading request.
  }
}

const calendarQuerySchema = z.object({
  fromDate: z.iso.date(),
  toDate: z.iso.date(),
  detailDate: z.iso.date().optional(),
  model: z.string().optional(),
  projectId: z.string().optional(),
  operation: z.string().optional(),
});

const totalsSelect = `
  COUNT(NULLIF(e.cache_hit, 1)) AS requests,
  COUNT(CASE WHEN e.cache_hit = 0 AND e.outcome = 'success' THEN 1 END) AS successes,
  COUNT(CASE WHEN e.cache_hit = 0 AND e.outcome = 'error' THEN 1 END) AS failures,
  COUNT(NULLIF(e.cache_hit, 0)) AS cacheHits,
  COUNT(CASE WHEN e.total_tokens IS NOT NULL OR e.input_tokens IS NOT NULL
    OR e.output_tokens IS NOT NULL THEN 1 END) AS usageReported,
  SUM(e.input_tokens) AS inputTokens,
  SUM(e.output_tokens) AS outputTokens,
  SUM(e.total_tokens) AS totalTokens,
  SUM(e.cache_read_tokens) AS cacheReadTokens
`;
const filteredEvents = `
  FROM history_usage_events e
  WHERE e.timestamp >= @start AND e.timestamp < @end
    AND (@model IS NULL OR e.model = @model)
    AND (@projectId IS NULL OR e.project_id = @projectId)
    AND (@operation IS NULL OR e.operation = @operation)
`;

function dayStart(date: string, next = false): number {
  const local = new Date(`${date}T00:00:00`);
  if (next) local.setDate(local.getDate() + 1);
  return local.getTime();
}

export function getHistoryUsageCalendar(
  query: HistoryUsageCalendarQuery,
): HistoryUsageCalendar {
  const { fromDate, toDate, detailDate, model, projectId, operation } =
    calendarQuerySchema.parse(query);
  if (fromDate > toDate) throw new Error('结束日期不能早于开始日期。');
  const database = usageDatabase();
  const filters = {
    start: dayStart(fromDate),
    end: dayStart(toDate, true),
    model: model ?? null,
    projectId: projectId ?? null,
    operation: operation ?? null,
  };
  const totals = database
    .prepare(`SELECT ${totalsSelect} ${filteredEvents}`)
    .get(filters) as HistoryUsageTotals;
  const days = database
    .prepare(
      `
    SELECT strftime('%Y-%m-%d', e.timestamp / 1000.0, 'unixepoch', 'localtime') AS date,
      ${totalsSelect}
    ${filteredEvents}
    GROUP BY date ORDER BY date
  `,
    )
    .all(filters) as HistoryUsageDay[];
  const rows =
    detailDate && detailDate >= fromDate && detailDate <= toDate
      ? (database
          .prepare(
            `
          SELECT e.id, e.timestamp, e.model, e.operation,
            (SELECT name FROM projects WHERE id = e.project_id) AS projectName,
            e.duration_ms AS durationMs, e.outcome, e.failure, e.cache_hit AS cacheHit,
            e.input_tokens AS inputTokens, e.output_tokens AS outputTokens,
            e.total_tokens AS totalTokens, e.cache_read_tokens AS cacheReadTokens
          ${filteredEvents}
          ORDER BY e.timestamp DESC, e.id DESC LIMIT 200
        `,
          )
          .all({
            ...filters,
            start: dayStart(detailDate),
            end: dayStart(detailDate, true),
          }) as (Omit<HistoryUsageEvent, 'cacheHit'> & { cacheHit: number })[])
      : [];
  const models = (
    database
      .prepare('SELECT DISTINCT model FROM history_usage_events ORDER BY model')
      .all() as { model: string }[]
  ).map(({ model: name }) => name);
  const operations = (
    database
      .prepare(
        'SELECT DISTINCT operation FROM history_usage_events ORDER BY operation',
      )
      .all() as { operation: string }[]
  ).map(({ operation: name }) => name);
  const projects = database
    .prepare(
      `
    SELECT DISTINCT e.project_id AS id, COALESCE(p.name, e.project_id) AS name
    FROM history_usage_events e LEFT JOIN projects p ON p.id = e.project_id
    WHERE e.project_id IS NOT NULL
    ORDER BY name, id
  `,
    )
    .all() as HistoryUsageCalendar['projects'];
  return {
    totals,
    days,
    models,
    operations,
    projects,
    events: rows.map((row) => ({ ...row, cacheHit: Boolean(row.cacheHit) })),
  };
}
