import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
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

async function modelServer(reply: object) {
  const requests: { model: string; messages: { content: unknown }[] }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: { content: JSON.stringify(reply) },
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

it('reuses OCR during rubric revision and exports the teacher-confirmed formal batch', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'neuromark-history-'));
  const recognition = await modelServer({
    status: 'readable',
    text: '工商业发展',
  });
  const grading = await modelServer({
    points: [
      { id: '1', score: 2, evidence: '工商业发展', reason: '写出经济原因' },
    ],
    comment: '补充经济发展如何产生影响。',
  });
  shared.database = new DatabaseSync(':memory:');
  shared.database.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY);
    INSERT INTO projects VALUES ('p');
    CREATE TABLE history_workspaces (project_id TEXT PRIMARY KEY, state_json TEXT NOT NULL);
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
    await service.saveProviders('p', {
      recognition: {
        baseUrl: recognition.baseUrl,
        model: 'vision',
        apiKey: 'fake',
      },
      grading: { baseUrl: grading.baseUrl, model: 'text', apiKey: 'fake' },
    });
    const draft: HistoryDraft = {
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
      ],
    };
    await service.saveDraft('p', 0, draft);
    await expect(service.start('p', 'formal')).rejects.toThrow('教师试阅');
    await service.start('p', 'trial', 1);
    const trial = async () => {
      await vi.waitFor(async () =>
        expect((await service.get('p')).trial?.status).toBe('review'),
      );
      return (await service.get('p')).trial!;
    };
    const first = await trial();
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
    expect(workbook.getWorksheet('学生总分')?.getCell('D2').value).toBe(1);
    expect(recognition.requests).toHaveLength(1);
    expect(JSON.stringify(recognition.requests)).toContain(
      'data:image/png;base64,',
    );
    expect(grading.requests).toHaveLength(3);
    expect(
      grading.requests.every(
        (request) =>
          request.model === 'text' &&
          typeof request.messages[1].content === 'string',
      ),
    ).toBe(true);
  } finally {
    shared.database.close();
    recognition.close();
    grading.close();
    await rm(dir, { recursive: true, force: true });
  }
});
