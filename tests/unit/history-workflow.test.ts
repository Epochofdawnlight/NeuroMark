import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { expect, it, vi } from 'vitest';
import { HistoryService } from '@main/services/history/historyService';
import type { ProjectService } from '@main/services/projectService';
import type { PaperRecord } from '@preload/contracts';
import type { HistoryDraft } from '@preload/history';
import { applyRubricProposal, mergeQuestionCatalog } from '@preload/examDraft';

const shared = vi.hoisted(() => ({
  database: undefined as DatabaseSync | undefined,
}));
vi.mock('@main/database/client', () => ({
  getDatabase: () => ({ $client: shared.database }),
}));
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}));

type ModelRequest = { model: string; messages: { content: unknown }[] };

async function modelServer(
  reply: object | ((request: ModelRequest) => object | Promise<object>),
) {
  const requests: ModelRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ModelRequest;
    requests.push(body);
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify(
                typeof reply === 'function' ? await reply(body) : reply,
              ),
            },
          },
        ],
      }),
    );
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('缺少本地测试端口');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

it('grades each image once with bounded concurrency and reuses unchanged trial results', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'neuromark-history-'));
  let requestsInFlight = 0;
  let peak = 0;
  const vision = await modelServer(async () => {
    peak = Math.max(peak, ++requestsInFlight);
    await delay(35);
    requestsInFlight -= 1;
    return {
      status: 'readable',
      text: '工商业发展',
      points: [
        { id: '1', score: 2, evidence: '工商业发展', reason: '写出经济原因' },
      ],
      comment: '补充经济发展如何产生影响。',
    };
  });
  const legacy = await modelServer({});
  shared.database = new DatabaseSync(':memory:');
  shared.database.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY);
    INSERT INTO projects VALUES ('p');
    CREATE TABLE history_workspaces (project_id TEXT PRIMARY KEY, state_json TEXT NOT NULL);
    CREATE TABLE history_provider_defaults (role TEXT PRIMARY KEY, config_json TEXT NOT NULL);
  `);
  try {
    const scan = path.join(dir, 'scan.png');
    await sharp({
      create: { width: 100, height: 100, channels: 3, background: 'white' },
    })
      .png()
      .toFile(scan);
    const papers: PaperRecord[] = [
      {
        id: 'p001',
        projectId: 'p',
        paperCode: '001',
        pageCount: 1,
        scanStatus: 'completed',
        gradingStatus: 'pending',
        originalPages: [
          {
            pageIndex: 0,
            originalPath: scan,
            scannedPath: scan,
            scannedVersion: Math.trunc((await stat(scan)).mtimeMs),
          },
        ],
      },
    ];
    const service = new HistoryService({
      getProjectById: async () => ({ id: 'p' }),
      listProjectPapers: async () => papers,
    } as unknown as ProjectService);
    await service.saveDefaultProvider('recognition', {
      baseUrl: vision.baseUrl,
      model: 'vision',
      apiKey: 'fake',
    });
    expect((await service.getDefaultProviders()).grading.model).toBe('vision');
    await service.saveDefaultProvider('grading', {
      baseUrl: legacy.baseUrl,
      model: 'text',
      apiKey: 'fake',
    });
    const draft: HistoryDraft = {
      fullPageRegionsConfirmed: true,
      reference: '工商业发展',
      material: '',
      questions: [
        {
          id: '17(1)',
          prompt: '概括经济原因',
          maxScore: 2,
          regions: [{ page: 0, x: 0.25, y: 0, width: 0.5, height: 0.5 }],
          criteria: [{ id: '1', text: '经济发展', maxScore: 2 }],
        },
        {
          id: '17(2)',
          prompt: '另举一项经济原因',
          maxScore: 2,
          regions: [{ page: 0, x: 0.25, y: 0.5, width: 0.5, height: 0.5 }],
          criteria: [{ id: '1', text: '工商业发展', maxScore: 2 }],
        },
      ],
    };
    await service.saveDraft('p', 0, draft);
    await expect(service.start('p', 'formal')).rejects.toThrow('教师试阅');
    await service.start('p', 'trial', 1, false, 2);
    const trial = async () => {
      await vi.waitFor(async () =>
        expect((await service.get('p')).trial?.status).toBe('review'),
      );
      return (await service.get('p')).trial!;
    };
    const first = await trial();
    expect(peak).toBe(2);
    expect(first.concurrency).toBe(2);
    expect(vision.requests).toHaveLength(2);
    expect(first.rows[0]).toMatchObject({
      status: 'scored',
      transcript: '工商业发展',
    });
    await expect(service.approveTrial('p', first.id)).rejects.toThrow('抽检');
    draft.questions[0].criteria[0].text = '工商业或贸易发展';
    await service.saveDraft('p', 1, draft);
    await service.start('p', 'trial', 1, true);
    const second = await trial();
    await service.audit(
      'p',
      { runId: second.id, paperId: 'p001', questionId: '17(1)' },
      2,
      '补充历史影响。',
      '',
    );
    await service.audit(
      'p',
      { runId: second.id, paperId: 'p001', questionId: '17(2)' },
      2,
      '论证可以更充分。',
      '',
    );
    await service.approveTrial('p', second.id);
    await service.start('p', 'formal');
    await vi.waitFor(async () =>
      expect((await service.get('p')).formal?.status).toBe('review'),
    );
    const formal = (await service.get('p')).formal!;
    await service.bindStudent('p', 'p001', '2026001', '测试学生');
    await service.audit(
      'p',
      { runId: formal.id, paperId: 'p001', questionId: '17(1)' },
      1,
      '请补充具体史实。',
      '历史解释不完整',
    );
    await service.confirmFormal('p', formal.id);
    const target = path.join(dir, 'results.xlsx');
    await service.export('p', formal.id, target);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(target);
    const detail = workbook.getWorksheet('逐题明细')!;
    expect([
      detail.getCell('B2').value,
      detail.getCell('G2').value,
      detail.getCell('H2').value,
    ]).toEqual(['2026001', 1, '请补充具体史实。']);
    expect(workbook.getWorksheet('学生总分')?.getCell('D2').value).toBe(3);
    expect(JSON.stringify(vision.requests)).toContain('data:image/png;base64,');
    expect(vision.requests).toHaveLength(5);
    draft.regionsByPaper = {
      p001: {
        '17(1)': [{ page: 0, x: 0.1, y: 0.55, width: 0.5, height: 0.4 }],
      },
    };
    await service.saveDraft('p', 2, draft);
    await service.start('p', 'trial', 1, true);
    const changed = await trial();
    expect(changed.rows[0].sources[0].region.y).toBe(0.55);
    expect(changed.rows[1].sources[0].region.y).toBe(0.5);
    expect(changed.rows[1].audit?.score).toBe(2);
    expect(vision.requests).toHaveLength(6);
    await service.start('p', 'trial', 1, true);
    await trial();
    expect(vision.requests).toHaveLength(6);
    expect(legacy.requests).toHaveLength(0);
    expect(
      vision.requests.every(
        (request) =>
          request.model === 'vision' &&
          Array.isArray(request.messages[1].content),
      ),
    ).toBe(true);
  } finally {
    shared.database.close();
    vision.close();
    legacy.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it('prepares an exam from mixed material and grades its 2B row locally', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'neuromark-exam-'));
  const vision = await modelServer((req) => {
    const system = String(req.messages[0].content);
    if (system.includes('印刷的小题'))
      return {
        items: [
          { id: '1', kind: 'choice', page: 1 },
          { id: '37（1）', kind: 'written', page: 1 },
        ],
      };
    if (system.startsWith('把教师'))
      return {
        message: '已整理',
        issues: [],
        items: [
          {
            id: '1',
            prompt: '单选',
            maxScore: 2,
            reference: '答案 B',
            source: '答案原文：1.B',
            criteria: [],
            answerKey: 'B',
          },
          {
            id: '37(1)',
            prompt: '说明目的',
            maxScore: 2,
            reference: '维护清政府统治',
            source: '给分说明',
            criteria: [{ id: '1', text: '指出维护清政府统治', maxScore: 2 }],
          },
        ],
      };
    return {
      status: 'readable',
      text: '维护清政府统治',
      points: [
        {
          id: '1',
          score: 2,
          evidence: '维护清政府统治',
          reason: '表述明确',
        },
      ],
      comment: '命中目的。',
    };
  });
  shared.database = new DatabaseSync(':memory:');
  shared.database.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY);
    INSERT INTO projects VALUES ('exam');
    CREATE TABLE history_workspaces (project_id TEXT PRIMARY KEY, state_json TEXT NOT NULL);
    CREATE TABLE history_provider_defaults (role TEXT PRIMARY KEY, config_json TEXT NOT NULL);
  `);
  try {
    const scan = path.join(dir, 'card.png');
    const body =
      '<svg width="200" height="200"><rect width="200" height="200" fill="white"/><rect x="63" y="16" width="25" height="20" fill="black"/></svg>';
    await sharp(Buffer.from(body)).png().toFile(scan);
    const papers: PaperRecord[] = [
      {
        id: 'p1',
        projectId: 'exam',
        paperCode: 'S01',
        pageCount: 1,
        scanStatus: 'completed',
        gradingStatus: 'pending',
        originalPages: [
          {
            pageIndex: 0,
            originalPath: scan,
            scannedPath: scan,
            scannedVersion: Math.trunc((await stat(scan)).mtimeMs),
          },
        ],
      },
    ];
    const service = new HistoryService({
      getProjectById: async () => ({ id: 'exam' }),
      listProjectPapers: async () => papers,
    } as unknown as ProjectService);
    await service.saveDefaultProvider('recognition', {
      baseUrl: vision.baseUrl,
      model: 'vision',
      apiKey: 'fake',
    });
    const items = await service.discoverCatalog('exam', 'p1', 0);
    expect(items.map((item) => item.id)).toEqual(['1', '37(1)']);
    const draft = mergeQuestionCatalog(
      { questions: [], reference: '', material: '' },
      items,
    );
    await service.saveDraft('exam', 0, draft);
    await expect(service.start('exam', 'trial', 1)).rejects.toThrow(
      '确认整页答题区域',
    );
    draft.choiceGrids = [
      {
        id: 'g',
        questionIds: ['1'],
        orientation: 'rows',
        region: { page: 0, x: 0, y: 0, width: 1, height: 0.25 },
      },
    ];
    draft.questions[1].regions = [
      { page: 0, x: 0.1, y: 0.45, width: 0.8, height: 0.4 },
    ];
    draft.fullPageRegionsConfirmed = true;
    draft.phase = 'rubric';
    draft.material = await service.readExamMaterials('exam', [
      {
        name: '规则.txt',
        data: Buffer.from('1.B，37（1）维护清政府统治，2分。'),
      },
    ]);
    await service.saveDraft('exam', 1, draft);
    const composed = await service.proposeRubric('exam', draft, '');
    const approved = applyRubricProposal(draft, composed);
    await service.saveDraft('exam', 2, { ...approved, phase: 'ready' });
    await service.start('exam', 'trial', 1);
    await vi.waitFor(async () =>
      expect((await service.get('exam')).trial?.status).toBe('review'),
    );
    const trial = (await service.get('exam')).trial!;
    expect(trial.rows[0]).toMatchObject({
      opticalMark: { status: 'single', selected: 'B' },
      grade: { score: 2 },
    });
    expect(trial.rows[1]).toMatchObject({
      transcript: '维护清政府统治',
      grade: { score: 2 },
    });
    expect(vision.requests).toHaveLength(3);
    expect(
      vision.requests.map(({ messages }) => Array.isArray(messages[1].content)),
    ).toEqual([true, false, true]);
  } finally {
    shared.database.close();
    vision.close();
    await rm(dir, { recursive: true, force: true });
  }
});
