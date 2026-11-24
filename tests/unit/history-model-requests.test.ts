import { afterEach, expect, it, vi } from 'vitest';
import {
  requestHistoryJson,
  type HistoryConnection,
  type HistoryUsageEvent,
} from '@main/services/history/historyModels';

const config: HistoryConnection = {
  baseUrl: 'https://fixture.invalid/v1',
  model: 'vision-fixture',
  hasKey: true,
  apiKey: 'fake',
};
const usage = { prompt_tokens: 27, completion_tokens: 9, total_tokens: 36 };

function completion(content = '{"ok":true}') {
  return Response.json({
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage,
  });
}

afterEach(() => vi.unstubAllGlobals());

it('records the rate limited attempt and the usage of one successful retry', async () => {
  const events: HistoryUsageEvent[] = [];
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      Response.json({ error: { message: 'rate limit' } }, { status: 429 }),
    )
    .mockResolvedValueOnce(completion());
  vi.stubGlobal('fetch', fetch);

  await expect(
    requestHistoryJson(
      { ...config, onUsage: (event) => events.push(event) },
      'system',
      'user',
      { operation: '样例' },
    ),
  ).resolves.toEqual({ ok: true });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(events).toEqual([
    expect.objectContaining({
      operation: '样例',
      outcome: 'error',
      failure: 'rate-limit',
      durationMs: expect.any(Number),
    }),
    expect.objectContaining({
      operation: '样例',
      outcome: 'success',
      rawUsage: usage,
    }),
  ]);
});

it('does not retry authentication errors or malformed model JSON', async () => {
  const events: HistoryUsageEvent[] = [];
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      Response.json({ error: { message: 'authentication' } }, { status: 401 }),
    )
    .mockResolvedValueOnce(completion('bad JSON'));
  vi.stubGlobal('fetch', fetch);
  const profile = {
    ...config,
    onUsage: (event: HistoryUsageEvent) => events.push(event),
  };

  await expect(requestHistoryJson(profile, 'system', 'user')).rejects.toThrow(
    'HTTP 401',
  );
  await expect(requestHistoryJson(profile, 'system', 'user')).rejects.toThrow(
    '不是有效 JSON',
  );
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(events.map((event) => event.failure)).toEqual(['http', 'response']);
});

it('collects usage from the streaming chunk after the finish reason', async () => {
  const events: HistoryUsageEvent[] = [];
  const chunks = [
    { choices: [{ delta: { content: '{"ok":true}' }, finish_reason: 'stop' }] },
    { choices: [], usage },
  ];
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
          'data: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
  );
  vi.stubGlobal('fetch', fetch);

  await expect(
    requestHistoryJson(
      { ...config, onUsage: (event) => events.push(event) },
      'system',
      'user',
      { stream: true },
    ),
  ).resolves.toEqual({ ok: true });
  const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
  expect(body.stream_options).toEqual({ include_usage: true });
  expect(events).toEqual([
    expect.objectContaining({ outcome: 'success', rawUsage: usage }),
  ]);
});

it('uses the profile deadline while reading the body and stops after a second timeout', async () => {
  const events: HistoryUsageEvent[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(
    async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener(
              'abort',
              () => controller.error(init.signal?.reason),
              { once: true },
            );
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
  );
  vi.stubGlobal('fetch', fetch);

  await expect(
    requestHistoryJson(
      { ...config, timeoutMs: 25, onUsage: (event) => events.push(event) },
      'system',
      'user',
      { timeoutMs: 10_000 },
    ),
  ).rejects.toThrow('等待超时');
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(events.map((event) => event.failure)).toEqual(['timeout', 'timeout']);
});

it('records an aborted in-flight request without retrying', async () => {
  const events: HistoryUsageEvent[] = [];
  const controller = new AbortController();
  const fetch = vi.fn<typeof globalThis.fetch>(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason),
          { once: true },
        );
        controller.abort();
      }),
  );
  vi.stubGlobal('fetch', fetch);

  await expect(
    requestHistoryJson(
      {
        ...config,
        signal: controller.signal,
        onUsage: (event) => events.push(event),
      },
      'system',
      'user',
    ),
  ).rejects.toThrow('已取消');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(events).toEqual([
    expect.objectContaining({ outcome: 'error', failure: 'cancelled' }),
  ]);
});
