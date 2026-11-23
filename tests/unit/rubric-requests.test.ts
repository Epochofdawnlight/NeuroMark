import { afterEach, expect, it, vi } from 'vitest';
import { organizeExamRubric } from '@main/services/history/examPreparation';
import { requestHistoryJson } from '@main/services/history/historyModels';
import type { HistoryDraft } from '@preload/history';

const config = {
  baseUrl: 'https://maas.qianwenaiapi.com/compatible-mode/v1',
  model: 'qwen3.8-flash',
  hasKey: true,
  apiKey: 'fixture-key',
};

afterEach(() => vi.unstubAllGlobals());

it('times out while the gateway is still writing the response body', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (_url: string, init: RequestInit) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init.signal?.addEventListener(
                'abort',
                () => controller.error(init.signal?.reason),
                { once: true },
              );
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    ),
  );
  await expect(
    requestHistoryJson(config, 'system', 'user', {
      operation: '评分细则修订',
      timeoutMs: 25,
    }),
  ).rejects.toThrow('评分细则修订等待超时');
});

it('distinguishes a malformed HTTP response from a connection failure', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('<html>gateway</html>', {
          headers: { 'Content-Type': 'application/json' },
        }),
    ),
  );
  await expect(requestHistoryJson(config, 'system', 'user')).rejects.toThrow(
    '接口响应格式无效',
  );
});

it('sends a compact follow-up and reads the Qwen streaming result', async () => {
  const materials = '学校练习原始参考材料。'.repeat(20);
  const pending = {
    id: '37(1)',
    prompt: '待应用题干',
    maxScore: 2,
    reference: '',
    criteria: [{ id: '1', text: '原采分点', maxScore: 2 }],
    source: '样例',
  };
  const draft: HistoryDraft = {
    phase: 'rubric',
    material: materials,
    reference: '',
    questions: [{ ...pending, prompt: '已保存题干', regions: [] }],
    rubricChat: [
      { role: 'teacher', text: materials },
      { role: 'assistant', text: '请看草稿' },
    ],
    rubricSuggestion: { message: '请看草稿', issues: [], items: [pending] },
  };
  const answer = JSON.stringify({ message: '已调整', issues: [], items: [] });
  const chunks = [
    { choices: [{ delta: { reasoning_content: 'ignored' } }] },
    { choices: [{ delta: { content: answer.slice(0, 11) } }] },
    {
      choices: [
        { delta: { content: answer.slice(11) }, finish_reason: 'stop' },
      ],
    },
  ];
  const fetchMock = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
          'data: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
  );
  vi.stubGlobal('fetch', fetchMock);

  await expect(
    organizeExamRubric(config, draft, '允许材料原文'),
  ).resolves.toMatchObject({
    message: '已调整',
  });
  const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1].body));
  const context = JSON.parse(body.messages[1].content);
  expect(body).toMatchObject({ stream: true, enable_thinking: false });
  expect(context.materials).toBe('');
  expect(context.initialTeacherMessage).toBe(materials);
  expect(context.conversation[0].text).not.toBe(materials);
  expect(context.questions[0]).toMatchObject({
    prompt: pending.prompt,
    pending: true,
    applied: { prompt: '已保存题干' },
  });
  expect(context).not.toHaveProperty('pendingItems');
});
