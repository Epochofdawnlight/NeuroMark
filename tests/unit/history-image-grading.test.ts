import { afterEach, expect, it, vi } from 'vitest';
import {
  gradeHistoryImage,
  readHandwrittenChoice,
  testHistoryConnection,
  type HistoryConnection,
} from '@main/services/history/historyModels';
import type { HistoryDraft, HistoryQuestion } from '@preload/history';

const config: HistoryConnection = {
  baseUrl: 'https://fixture.invalid/v1',
  model: 'vision-fixture',
  hasKey: true,
  apiKey: 'fake',
};
const question: HistoryQuestion = {
  id: '17(1)',
  prompt: '概括经济原因。',
  maxScore: 2,
  regions: [],
  criteria: [{ id: '1', text: '说明经济发展', maxScore: 2 }],
};
const draft: HistoryDraft = {
  questions: [question],
  reference: '工商业发展',
  material: '',
};
const crops = [
  'data:image/png;base64,Y3JvcDE=',
  'data:image/png;base64,Y3JvcDI=',
];
const grade = {
  points: [
    { id: '1', score: 2, evidence: '工商业发展', reason: '写出经济原因' },
  ],
  comment: '可以举出工商业发展的具体例子。',
};

function mockCompletion(result: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({
      id: 'fixture',
      object: 'chat.completion',
      created: 0,
      model: 'vision-fixture',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: JSON.stringify(result) },
          finish_reason: 'stop',
        },
      ],
    }),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

it('reads and scores the ordered original crops in a single model request', async () => {
  const fetch = mockCompletion({
    status: 'readable',
    text: '工商业发展',
    ...grade,
  });

  const result = await gradeHistoryImage(config, question, draft, crops);

  expect(result).toEqual({
    status: 'readable',
    text: '工商业发展',
    grade: { score: 2, ...grade },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  const request = JSON.parse(String(fetch.mock.calls[0][1]?.body));
  expect(request.messages[1].content.slice(1)).toEqual(
    crops.map((url) => ({ type: 'image_url', image_url: { url } })),
  );
});

it('returns visible text and a review reason without scoring unreadable marks', async () => {
  const cause = '第二行年份的改写笔画重叠，无法确认最后两位。';
  mockCompletion({
    status: 'unreadable',
    text: '工商业发展',
    reviewReason: cause,
    ...grade,
  });

  await expect(
    gradeHistoryImage(config, question, draft, crops),
  ).resolves.toEqual({
    status: 'unreadable',
    text: '工商业发展',
    reviewReason: cause,
  });
});

it('routes a reported uncertainty to review even if the model marks the answer readable', async () => {
  const cause = '第一行横线可能是删除线，也可能是下划线。';
  mockCompletion({
    status: 'readable',
    text: '工商业发展',
    reviewReason: cause,
    ...grade,
  });

  await expect(
    gradeHistoryImage(config, question, draft, crops),
  ).resolves.toEqual({
    status: 'unreadable',
    text: '工商业发展',
    reviewReason: cause,
  });
});

it('returns a blank answer without a model score when no valid answer remains', async () => {
  mockCompletion({ status: 'blank', text: '', ...grade });

  await expect(
    gradeHistoryImage(config, question, draft, crops),
  ).resolves.toEqual({
    status: 'blank',
    text: '',
  });
});

it('uses the teacher correction for text and evidence even if the model reports a different reading', async () => {
  const fetch = mockCompletion({
    status: 'unreadable',
    text: '农业发展',
    ...grade,
  });

  await expect(
    gradeHistoryImage(config, question, draft, crops, ' 工商业发展 '),
  ).resolves.toEqual({
    status: 'readable',
    text: '工商业发展',
    grade: { score: 2, ...grade },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  const request = JSON.parse(String(fetch.mock.calls[0][1]?.body));
  expect(JSON.parse(request.messages[1].content[0].text).teacherText).toBe(
    '工商业发展',
  );
  expect(request.messages[1].content).toHaveLength(3);
});

it('preserves the authoritative reading and proposed grade for unsupported evidence review', async () => {
  mockCompletion({ status: 'readable', text: '工商业发展', ...grade });

  await expect(
    gradeHistoryImage(config, question, draft, crops, '农业发展'),
  ).resolves.toMatchObject({
    status: 'unreadable',
    text: '农业发展',
    reviewReason: expect.stringContaining('给分依据必须引用学生答案原文'),
    suggestedGrade: { score: 2, points: [{ evidence: '' }] },
  });
});

it('maps nonconsecutive cited segment IDs to their original lines', async () => {
  mockCompletion({
    status: 'readable',
    segments: [
      { id: 'L1', text: '工商业发展' },
      { id: 'L2', text: '政治制度变迁' },
      { id: 'L3', text: '经济联系加强' },
    ],
    points: [
      { id: '1', score: 2, segmentIds: ['L1', 'L3'], reason: '说明经济发展' },
    ],
    comment: '可增加一则史实。',
  });

  await expect(
    gradeHistoryImage(config, question, draft, crops),
  ).resolves.toMatchObject({
    status: 'readable',
    text: '工商业发展\n政治制度变迁\n经济联系加强',
    grade: { score: 2, points: [{ evidence: '工商业发展\n经济联系加强' }] },
  });
});

it('puts missing segment IDs into review while preserving the original reading', async () => {
  mockCompletion({
    status: 'readable',
    segments: [{ id: 'L1', text: '工商业发展' }],
    points: [{ id: '1', score: 2, segmentIds: ['L2'], reason: '说明经济发展' }],
    comment: '可增加一则史实。',
  });

  const result = await gradeHistoryImage(config, question, draft, crops);
  expect(result).toMatchObject({
    status: 'unreadable',
    text: '工商业发展',
    reviewReason: expect.stringContaining('L2'),
    suggestedGrade: { score: 2, points: [{ evidence: '' }] },
  });
  expect(result).not.toHaveProperty('grade');
});

it('retains visible lines even when a segment ID is malformed', async () => {
  mockCompletion({
    status: 'readable',
    segments: [{ id: '第一行', text: '工商业发展' }],
    ...grade,
  });

  await expect(
    gradeHistoryImage(config, question, draft, crops),
  ).resolves.toMatchObject({
    status: 'unreadable',
    text: '工商业发展',
    reviewReason: expect.stringContaining('片段格式无效'),
  });
});

it.each([
  [
    { status: 'single', options: ['B'] },
    { status: 'single', selected: 'B', marks: [] },
  ],
  [
    { status: 'blank', options: [] },
    { status: 'blank', marks: [] },
  ],
  [
    { status: 'multiple', options: ['B', 'A'] },
    { status: 'multiple', marks: [] },
  ],
  [
    { status: 'single', options: ['B', 'A'] },
    { status: 'uncertain', marks: [] },
  ],
])(
  'reads handwritten choice reply %j from one target crop',
  async (reply, expected) => {
    const fetch = mockCompletion(reply);

    await expect(readHandwrittenChoice(config, crops[0])).resolves.toEqual(
      expected,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    const request = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(request.messages[1].content.slice(1)).toEqual([
      { type: 'image_url', image_url: { url: crops[0] } },
    ]);
  },
);

it('requires the vision probe to read and score the synthetic crop', async () => {
  const fetch = mockCompletion({ status: 'blank', text: '' });

  await expect(testHistoryConnection(config, true)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('accepts the vision probe when the model reads and scores the synthetic crop', async () => {
  const fetch = mockCompletion({
    status: 'readable',
    text: '1789',
    points: [
      { id: 'probe', score: 1, evidence: '1789', reason: '写出了四位年份' },
    ],
    comment: '作答完整。',
  });

  await expect(testHistoryConnection(config, true)).resolves.toBeUndefined();
  const request = JSON.parse(String(fetch.mock.calls[0][1]?.body));
  expect(request.messages[1].content[1].image_url.url).toMatch(
    /^data:image\/png;base64,/,
  );
  expect(request.messages[1].content[0].text).not.toContain('1789');
});
