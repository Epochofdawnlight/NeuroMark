import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { safeStorage } from 'electron';
import ExcelJS from 'exceljs';
import { getDatabase } from '@main/database/client';
import type { ProjectService } from '@main/services/projectService';
import type { PaperRecord } from '@preload/contracts';
import type {
  HistoryDraft,
  HistoryEndpoint,
  HistoryEndpointInput,
  HistoryProviderInput,
  HistoryProviderSettings,
  HistoryRegion,
  HistoryRow,
  HistoryRowRef,
  HistoryRun,
  HistorySnapshot,
  HistorySource,
} from '@preload/history';
import {
  buildTrialReport,
  historyRegionsSchema,
  regionsForQuestion,
  validateHistoryDraft,
} from './historyRules';
import {
  cropHistorySource,
  gradeHistoryAnswer,
  testHistoryConnection,
  transcribeHistoryAnswer,
  type HistoryConnection,
  type HistoryTranscript,
} from './historyModels';

type Role = keyof HistoryProviderSettings;
type StoredEndpoint = Omit<HistoryEndpoint, 'hasKey'> & {
  encryptedKey: string;
};
type Identity = { studentId: string; name: string };
const providerRoles = ['recognition', 'grading'] as const;
type StoredProviders = Record<Role, StoredEndpoint>;

interface Workspace {
  revision: number;
  providerRevision: number;
  draft: HistoryDraft;
  providers: Record<Role, StoredEndpoint>;
  approvedTrialId?: string;
  trial?: HistoryRun;
  formal?: HistoryRun;
  pastRuns: HistoryRun[];
  transcriptions: Record<string, HistoryTranscript>;
  identities: Record<string, Identity>;
}

function emptyWorkspace(): Workspace {
  return {
    revision: 0,
    providerRevision: 0,
    draft: { reference: '', material: '', questions: [] },
    providers: {
      recognition: {
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3-vl-plus',
        encryptedKey: '',
      },
      grading: { baseUrl: '', model: '', encryptedKey: '' },
    },
    pastRuns: [],
    transcriptions: {},
    identities: {},
  };
}

function publicEndpoint(config: StoredEndpoint): HistoryEndpoint {
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    hasKey: Boolean(config.encryptedKey),
  };
}

function providersFor(providers: StoredProviders): HistoryProviderSettings {
  return {
    recognition: publicEndpoint(providers.recognition),
    grading: publicEndpoint(providers.grading),
  };
}

function parseRole(role: Role): Role {
  if (!providerRoles.includes(role)) throw new Error('未知的 API 类型。');
  return role;
}

function updateEndpoint(
  input: HistoryEndpointInput,
  previous?: StoredEndpoint,
): StoredEndpoint {
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
  const model = input.model.trim();
  if (!baseUrl || !model) throw new Error('请填写此 API 的地址和模型。');
  const url = new URL(baseUrl);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ))
  ) {
    throw new Error('API 地址须为 HTTPS 或本机 HTTP，且地址中不能包含凭据。');
  }
  let encryptedKey = previous?.baseUrl === baseUrl ? previous.encryptedKey : '';
  if (input.apiKey?.trim()) {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error('系统密钥存储不可用。');
    encryptedKey = safeStorage
      .encryptString(input.apiKey.trim())
      .toString('base64');
  }
  if (!encryptedKey)
    throw new Error('请填写此 API 的密钥。本机服务可使用占位密钥。');
  return { baseUrl, model, encryptedKey };
}

function providerSignature(providers: StoredProviders): string {
  return createHash('sha256').update(JSON.stringify(providers)).digest('hex');
}

function sameProviders(
  run: HistoryRun,
  state: Workspace,
  providers: StoredProviders,
): boolean {
  return run.providerSignature
    ? run.providerSignature === providerSignature(providers)
    : state.providerRevision === run.providerRevision &&
        providerSignature(state.providers) === providerSignature(providers);
}

function connectionFor(config: StoredEndpoint): HistoryConnection {
  if (!config.baseUrl || !config.model || !config.encryptedKey) {
    throw new Error('请先配置此 API 的地址、模型与密钥。');
  }
  return {
    ...publicEndpoint(config),
    apiKey: safeStorage.decryptString(
      Buffer.from(config.encryptedKey, 'base64'),
    ),
  };
}

function findRun(state: Workspace, id: string): HistoryRun {
  const run = [state.trial, state.formal, ...state.pastRuns].find(
    (item) => item?.id === id,
  );
  if (!run) throw new Error('找不到该阅卷批次。');
  return run;
}

function findRow(run: HistoryRun, ref: HistoryRowRef): HistoryRow {
  const row = run.rows.find(
    (item) =>
      item.paperId === ref.paperId && item.questionId === ref.questionId,
  );
  if (!row) throw new Error('找不到该份答卷的小题。');
  return row;
}

function randomPapers(papers: PaperRecord[], count: number): PaperRecord[] {
  const pool = papers.slice();
  for (let index = 0; index < Math.min(count, pool.length); index += 1) {
    const other = index + Math.floor(Math.random() * (pool.length - index));
    [pool[index], pool[other]] = [pool[other], pool[index]];
  }
  return pool.slice(0, count);
}

function buildRows(papers: PaperRecord[], draft: HistoryDraft): HistoryRow[] {
  return papers.flatMap((paper) =>
    draft.questions.map((question) => {
      const regions = regionsForQuestion(draft, paper.id, question);
      const sources = sourcesForRegions(paper, regions);
      const missing = !regions.length || sources.length !== regions.length;
      return {
        paperId: paper.id,
        paperCode: paper.paperCode,
        questionId: question.id,
        sources,
        cacheKey: JSON.stringify([paper.id, question.id, sources]),
        status: missing ? 'error' : 'pending',
        error: !regions.length
          ? '这道小题还没有作答区域。请在答题区域工作台补画。'
          : missing
            ? '作答所需页面缺失或未扫描。请核对原卷与题框。'
            : undefined,
      };
    }),
  );
}

function sourcesForRegions(
  paper: PaperRecord,
  regions: HistoryRegion[],
): HistorySource[] {
  return regions.flatMap((region) => {
    const page = paper.originalPages.find(
      (item) => item.pageIndex === region.page,
    );
    return page?.scannedPath
      ? [
          {
            region,
            file: page.scannedPath,
            version: page.scannedVersion ?? null,
          },
        ]
      : [];
  });
}

function regionCount(run: HistoryRun, row: HistoryRow): number {
  const question = run.draft.questions.find((q) => q.id === row.questionId);
  return question
    ? regionsForQuestion(run.draft, row.paperId, question).length
    : 0;
}

function reuseTrialRows(
  rows: HistoryRow[],
  draft: HistoryDraft,
  prior: HistoryRun,
): HistoryRow[] {
  if (
    draft.reference !== prior.draft.reference ||
    draft.material !== prior.draft.material
  )
    return rows;
  const unchanged = new Set(
    draft.questions
      .filter((question) => {
        const previous = prior.draft.questions.find(
          (item) => item.id === question.id,
        );
        return (
          previous &&
          question.prompt === previous.prompt &&
          question.maxScore === previous.maxScore &&
          JSON.stringify(question.criteria) ===
            JSON.stringify(previous.criteria)
        );
      })
      .map((question) => question.id),
  );
  const eligible = new Map(
    prior.rows
      .filter(
        (row) =>
          unchanged.has(row.questionId) &&
          (row.status === 'scored' || row.status === 'blank'),
      )
      .map((row) => [row.cacheKey, row]),
  );
  return rows.map((row) => {
    const previous =
      row.status === 'pending' ? eligible.get(row.cacheKey) : undefined;
    return previous ? structuredClone(previous) : row;
  });
}

export class HistoryService {
  private active = new Set<string>();

  constructor(private projects: ProjectService) {}

  private savedDefaults(): Partial<StoredProviders> {
    const rows = getDatabase()
      .$client.prepare(
        'SELECT role, config_json FROM history_provider_defaults',
      )
      .all() as { role: Role; config_json: string }[];
    return Object.fromEntries(
      rows
        .filter((row) => providerRoles.includes(row.role))
        .map((row) => [
          row.role,
          JSON.parse(row.config_json) as StoredEndpoint,
        ]),
    );
  }

  private effectiveProviders(state: Workspace): StoredProviders {
    return { ...state.providers, ...this.savedDefaults() };
  }

  private writeDefault(role: Role, endpoint: StoredEndpoint): void {
    getDatabase()
      .$client.prepare(
        `
      INSERT INTO history_provider_defaults (role, config_json) VALUES (?, ?)
      ON CONFLICT(role) DO UPDATE SET config_json = excluded.config_json
    `,
      )
      .run(role, JSON.stringify(endpoint));
  }

  async getDefaultProviders(): Promise<HistoryProviderSettings> {
    return providersFor(this.effectiveProviders(emptyWorkspace()));
  }

  async saveDefaultProvider(
    role: Role,
    input: HistoryEndpointInput,
  ): Promise<void> {
    parseRole(role);
    this.writeDefault(role, updateEndpoint(input, this.savedDefaults()[role]));
  }

  async testDefaultProvider(role: Role): Promise<void> {
    parseRole(role);
    const endpoint = this.effectiveProviders(emptyWorkspace())[role];
    await testHistoryConnection(
      connectionFor(endpoint),
      role === 'recognition',
    );
  }

  async adoptProviders(projectId: string): Promise<void> {
    await this.projects.getProjectById(projectId);
    const state = this.load(projectId);
    const saved = this.savedDefaults();
    for (const role of providerRoles) {
      if (!saved[role] && state.providers[role].encryptedKey)
        this.writeDefault(role, state.providers[role]);
    }
  }

  async previewRegions(
    projectId: string,
    paperId: string,
    input: HistoryRegion[],
  ): Promise<string[]> {
    const paper = (await this.projects.listProjectPapers(projectId)).find(
      (item) => item.id === paperId,
    );
    if (!paper) throw new Error('找不到答题卡。');
    const regions = historyRegionsSchema.parse(input);
    const sources = sourcesForRegions(paper, regions);
    if (!regions.length || sources.length !== regions.length)
      throw new Error('请添加题框并检查所需页是否已扫描。');
    return Promise.all(sources.map(cropHistorySource));
  }

  private load(projectId: string): Workspace {
    const result = getDatabase()
      .$client.prepare(
        'SELECT state_json FROM history_workspaces WHERE project_id = ?',
      )
      .get(projectId) as { state_json: string } | undefined;
    return result
      ? ({ ...emptyWorkspace(), ...JSON.parse(result.state_json) } as Workspace)
      : emptyWorkspace();
  }

  private write(projectId: string, state: Workspace): void {
    const result = getDatabase()
      .$client.prepare(
        `
      INSERT INTO history_workspaces (project_id, state_json)
      SELECT ?, ? WHERE EXISTS (SELECT 1 FROM projects WHERE id = ?)
      ON CONFLICT(project_id) DO UPDATE SET state_json = excluded.state_json
    `,
      )
      .run(projectId, JSON.stringify(state), projectId);
    if (!result.changes) throw new Error('该阅卷项目已删除。');
  }

  private ensureIdle(projectId: string): void {
    if (this.active.has(projectId))
      throw new Error('该项目已有历史批阅任务在运行。');
  }

  private shownRun(
    projectId: string,
    run: HistoryRun | undefined,
  ): HistoryRun | undefined {
    return run?.status === 'running' && !this.active.has(projectId)
      ? { ...run, status: 'paused' }
      : run;
  }

  async get(projectId: string): Promise<HistorySnapshot> {
    await this.projects.getProjectById(projectId);
    const state = this.load(projectId);
    const saved = this.savedDefaults();
    const providers = { ...state.providers, ...saved };
    return {
      revision: state.revision,
      draft: state.draft,
      providers: providersFor(providers),
      canAdoptProviders: providerRoles.some(
        (role) => !saved[role] && state.providers[role].encryptedKey,
      ),
      approvedTrialId: this.approved(state, providers)
        ? state.approvedTrialId
        : undefined,
      identities: state.identities,
      trial: this.shownRun(projectId, state.trial),
      formal: this.shownRun(projectId, state.formal),
      report: state.trial
        ? buildTrialReport(state.trial.draft.questions, state.trial.rows)
        : [],
      pastRuns: state.pastRuns.map(
        ({ rows: _rows, draft: _draft, ...rest }) => rest,
      ),
    };
  }

  async getRun(projectId: string, runId: string): Promise<HistoryRun> {
    await this.projects.getProjectById(projectId);
    return this.shownRun(projectId, findRun(this.load(projectId), runId))!;
  }

  async bindStudent(
    projectId: string,
    paperId: string,
    studentId: string,
    name: string,
  ): Promise<void> {
    const papers = await this.projects.listProjectPapers(projectId);
    this.ensureIdle(projectId);
    if (!papers.some((paper) => paper.id === paperId))
      throw new Error('该答卷已不存在。');
    const state = this.load(projectId);
    studentId = studentId.trim();
    if (
      studentId &&
      Object.entries(state.identities).some(
        ([id, identity]) => id !== paperId && identity.studentId === studentId,
      )
    )
      throw new Error('此学号已绑定至另一份答卷。');
    state.identities = {
      ...state.identities,
      [paperId]: { studentId, name: name.trim() },
    };
    this.write(projectId, state);
  }

  async saveProviders(
    projectId: string,
    input: HistoryProviderInput,
  ): Promise<void> {
    await this.projects.getProjectById(projectId);
    this.ensureIdle(projectId);
    const state = this.load(projectId);
    const before = JSON.stringify(state.providers);
    for (const role of providerRoles) {
      state.providers[role] = updateEndpoint(
        input[role],
        state.providers[role],
      );
    }
    if (before !== JSON.stringify(state.providers)) {
      state.providerRevision += 1;
      state.approvedTrialId = undefined;
    }
    this.write(projectId, state);
  }

  async testProvider(projectId: string, role: Role): Promise<void> {
    await this.projects.getProjectById(projectId);
    parseRole(role);
    await testHistoryConnection(
      connectionFor(this.effectiveProviders(this.load(projectId))[role]),
      role === 'recognition',
    );
  }

  async saveDraft(
    projectId: string,
    revision: number,
    input: HistoryDraft,
  ): Promise<void> {
    await this.projects.getProjectById(projectId);
    this.ensureIdle(projectId);
    const state = this.load(projectId);
    if (state.revision !== revision)
      throw new Error('细则已经更新，请刷新后编辑。');
    const draft = validateHistoryDraft(input);
    if (JSON.stringify(draft) === JSON.stringify(state.draft)) return;
    state.revision += 1;
    state.draft = draft;
    state.approvedTrialId = undefined;
    this.write(projectId, state);
  }

  async start(
    projectId: string,
    kind: HistoryRun['kind'],
    sampleSize = 10,
    repeat = false,
  ): Promise<void> {
    if (kind !== 'formal' && kind !== 'trial')
      throw new Error('未知的批阅类型。');
    this.ensureIdle(projectId);
    this.active.add(projectId);
    try {
      const papers = await this.projects.listProjectPapers(projectId);
      const state = this.load(projectId);
      const draft = validateHistoryDraft(state.draft);
      const providers = this.effectiveProviders(state);
      const connections = this.connections(providers);
      if (!papers.length) throw new Error('项目中没有答卷。');
      if (kind === 'formal' && !this.approved(state, providers))
        throw new Error('请先通过当前版本的教师试阅。');
      if (!Number.isInteger(sampleSize) || sampleSize < 1)
        throw new Error('试阅份数必须为正整数。');
      const prior = new Set(state.trial?.rows.map((row) => row.paperId));
      const selected =
        kind === 'formal'
          ? papers
          : repeat
            ? papers.filter((paper) => prior.has(paper.id))
            : randomPapers(papers, sampleSize);
      if (!selected.length) throw new Error('没有可用于该批次的答卷。');
      if (kind === 'trial' && repeat && selected.length !== prior.size) {
        throw new Error('原样本中的答卷已移除，请重新随机抽取。');
      }
      const rows = buildRows(selected, draft);
      const previous = state[kind];
      const run: HistoryRun = {
        id: randomUUID(),
        kind,
        revision: state.revision,
        providerRevision: state.providerRevision,
        providerSignature: providerSignature(providers),
        providers: providersFor(providers),
        draft,
        sampledPapers: selected.length,
        totalPapers: papers.length,
        rows:
          kind === 'trial' &&
          repeat &&
          previous &&
          sameProviders(previous, state, providers)
            ? reuseTrialRows(rows, draft, previous)
            : rows,
        status: 'running',
        createdAt: new Date().toISOString(),
      };
      if (previous) state.pastRuns.unshift(this.shownRun('', previous)!);
      state[kind] = run;
      if (kind === 'trial') state.approvedTrialId = undefined;
      this.write(projectId, state);
      void this.process(projectId, state, run, connections);
    } catch (error) {
      this.active.delete(projectId);
      throw error;
    }
  }

  private connections(providers: StoredProviders) {
    return {
      recognition: connectionFor(providers.recognition),
      grading: connectionFor(providers.grading),
    };
  }

  async resume(projectId: string, runId: string): Promise<void> {
    await this.projects.getProjectById(projectId);
    this.ensureIdle(projectId);
    const state = this.load(projectId);
    const run = findRun(state, runId);
    const providers = this.effectiveProviders(state);
    if (
      state[run.kind]?.id !== run.id ||
      run.status === 'confirmed' ||
      !sameProviders(run, state, providers)
    ) {
      throw new Error('请使用原模型设置重试当前批次，或重新开始试阅。');
    }
    const connections = this.connections(providers);
    for (const row of run.rows) {
      if (
        row.status === 'error' &&
        !row.audit &&
        row.sources.length > 0 &&
        row.sources.length === regionCount(run, row)
      )
        row.status = 'pending';
    }
    if (!run.rows.some((row) => row.status === 'pending'))
      throw new Error('当前无可重试项。');
    if (run.kind === 'trial') state.approvedTrialId = undefined;
    this.active.add(projectId);
    run.status = 'running';
    try {
      this.write(projectId, state);
      void this.process(projectId, state, run, connections);
    } catch (error) {
      this.active.delete(projectId);
      throw error;
    }
  }

  private async process(
    projectId: string,
    state: Workspace,
    run: HistoryRun,
    connections: ReturnType<HistoryService['connections']>,
  ): Promise<void> {
    try {
      for (const row of run.rows) {
        if (row.status !== 'pending') continue;
        try {
          const autoKey = JSON.stringify([
            run.providers.recognition.baseUrl,
            run.providers.recognition.model,
            row.cacheKey,
          ]);
          const stored =
            state.transcriptions[row.cacheKey] ?? state.transcriptions[autoKey];
          const recognized =
            stored ??
            (await transcribeHistoryAnswer(
              connections.recognition,
              await Promise.all(row.sources.map(cropHistorySource)),
            ));
          if (!stored) state.transcriptions[autoKey] = recognized;
          await this.gradeRow(row, recognized, run, connections.grading);
        } catch (error) {
          row.status = 'error';
          row.error = error instanceof Error ? error.message : '阅卷失败。';
        }
        this.write(projectId, state);
      }
      run.status = 'review';
      this.write(projectId, state);
    } catch (error) {
      console.error('无法保存历史阅卷进度', error);
    } finally {
      this.active.delete(projectId);
    }
  }

  private async gradeRow(
    row: HistoryRow,
    transcript: HistoryTranscript,
    run: HistoryRun,
    grading: HistoryConnection,
  ) {
    row.transcript = transcript.text;
    row.grade = undefined;
    row.audit = undefined;
    row.error = undefined;
    if (transcript.status !== 'readable') {
      row.status = transcript.status;
      return;
    }
    const question = run.draft.questions.find((q) => q.id === row.questionId)!;
    row.grade = await gradeHistoryAnswer(
      grading,
      question,
      run.draft,
      transcript.text,
    );
    row.status = 'scored';
  }

  async preview(projectId: string, ref: HistoryRowRef): Promise<string[]> {
    await this.projects.getProjectById(projectId);
    const row = findRow(findRun(this.load(projectId), ref.runId), ref);
    return Promise.all(row.sources.map(cropHistorySource));
  }

  private editableRow(
    state: Workspace,
    ref: HistoryRowRef,
  ): { run: HistoryRun; row: HistoryRow } {
    const run = findRun(state, ref.runId);
    if (run.status !== 'review' || state[run.kind]?.id !== run.id)
      throw new Error('只有当前待复核批次可以编辑。');
    return { run, row: findRow(run, ref) };
  }

  async correctTranscript(
    projectId: string,
    ref: HistoryRowRef,
    text: string,
  ): Promise<void> {
    await this.projects.getProjectById(projectId);
    this.ensureIdle(projectId);
    const state = this.load(projectId);
    const { run, row } = this.editableRow(state, ref);
    const providers = this.effectiveProviders(state);
    if (!sameProviders(run, state, providers)) {
      throw new Error('评分配置已经变更，请重新试阅。');
    }
    if (!row.sources.length || row.sources.length !== regionCount(run, row)) {
      throw new Error('存在缺失页，无法确认转录。请先修复扫描件。');
    }
    const grading = connectionFor(providers.grading);
    const value = text.trim();
    const transcript: HistoryTranscript = value
      ? { status: 'readable', text: value }
      : { status: 'blank', text: '' };
    this.active.add(projectId);
    try {
      row.edits ??= [];
      row.edits.push({
        kind: 'transcript',
        at: new Date().toISOString(),
        previous: row.transcript ?? '',
        current: value,
      });
      state.transcriptions[row.cacheKey] = transcript;
      if (run.kind === 'trial') state.approvedTrialId = undefined;
      try {
        await this.gradeRow(row, transcript, run, grading);
      } catch (error) {
        row.status = 'error';
        row.error = error instanceof Error ? error.message : '重新评分失败。';
      }
      this.write(projectId, state);
    } finally {
      this.active.delete(projectId);
    }
  }

  async audit(
    projectId: string,
    ref: HistoryRowRef,
    score: number,
    comment: string,
    note: string,
  ): Promise<void> {
    await this.projects.getProjectById(projectId);
    this.ensureIdle(projectId);
    const state = this.load(projectId);
    const { run, row } = this.editableRow(state, ref);
    const q = run.draft.questions.find((item) => item.id === row.questionId)!;
    if (
      !Number.isFinite(score) ||
      score < 0 ||
      score > q.maxScore ||
      !comment.trim()
    ) {
      throw new Error('请输入有效分数和学生评语。');
    }
    if (
      score !==
        (row.grade?.score ?? (row.status === 'blank' ? 0 : undefined)) &&
      !note.trim()
    ) {
      throw new Error('改分或处理异常需要说明原因。');
    }
    row.audit = {
      at: new Date().toISOString(),
      score,
      comment: comment.trim(),
      note: note.trim(),
    };
    row.edits ??= [];
    row.edits.push({ kind: 'score', ...row.audit });
    if (run.kind === 'trial') state.approvedTrialId = undefined;
    this.write(projectId, state);
  }

  private approved(state: Workspace, providers: StoredProviders): boolean {
    return Boolean(
      state.approvedTrialId &&
      state.trial?.id === state.approvedTrialId &&
      state.trial.revision === state.revision &&
      sameProviders(state.trial, state, providers),
    );
  }

  async approveTrial(projectId: string, runId: string): Promise<void> {
    await this.projects.getProjectById(projectId);
    this.ensureIdle(projectId);
    const state = this.load(projectId);
    const trial = state.trial;
    if (
      !trial ||
      trial.id !== runId ||
      trial.revision !== state.revision ||
      trial.status !== 'review' ||
      !sameProviders(trial, state, this.effectiveProviders(state))
    ) {
      throw new Error('请对当前细则和模型配置重新试阅。');
    }
    if (
      trial.draft.questions.some(
        (q) => !trial.rows.some((row) => row.questionId === q.id && row.audit),
      )
    ) {
      throw new Error('每道小题至少需要确认一份抽检记录。');
    }
    if (
      trial.rows.some(
        (row) => ['error', 'unreadable'].includes(row.status) && !row.audit,
      )
    ) {
      throw new Error('请先处理试阅中的识别异常和失败项。');
    }
    state.approvedTrialId = trial.id;
    this.write(projectId, state);
  }

  async confirmFormal(projectId: string, runId: string): Promise<void> {
    await this.projects.getProjectById(projectId);
    this.ensureIdle(projectId);
    const state = this.load(projectId);
    const run = state.formal;
    if (
      !run ||
      run.id !== runId ||
      run.status !== 'review' ||
      run.rows.some(
        (row) =>
          !row.audit && row.status !== 'scored' && row.status !== 'blank',
      )
    ) {
      throw new Error('请先处理所有未完成或异常的作答。');
    }
    run.status = 'confirmed';
    run.identities = state.identities;
    this.write(projectId, state);
  }

  async export(
    projectId: string,
    runId: string,
    target: string,
  ): Promise<void> {
    await this.projects.getProjectById(projectId);
    if (path.extname(target).toLowerCase() !== '.xlsx')
      throw new Error('请选择 .xlsx 文件。');
    const state = this.load(projectId);
    const run = findRun(state, runId);
    if (run.kind !== 'formal' || run.status !== 'confirmed')
      throw new Error('请先确认正式批阅结果。');
    const workbook = new ExcelJS.Workbook();
    const detail = workbook.addWorksheet('逐题明细');
    detail.addRow([
      '卷号',
      '学号',
      '姓名',
      '题号',
      '满分',
      'AI建议分',
      '最终得分',
      '学生评语',
      '给分依据',
      '复核说明',
      '细则版本',
    ]);
    const totals = new Map<string, number>();
    const identity = (id: string) => run.identities?.[id];
    for (const row of run.rows) {
      const q = run.draft.questions.find((item) => item.id === row.questionId)!;
      const score = row.audit?.score ?? row.grade?.score ?? 0;
      const comment =
        row.audit?.comment ?? row.grade?.comment ?? '本题未作答。';
      detail.addRow([
        row.paperCode,
        identity(row.paperId)?.studentId,
        identity(row.paperId)?.name,
        row.questionId,
        q.maxScore,
        row.grade?.score ?? (row.status === 'blank' ? 0 : null),
        score,
        comment,
        row.grade?.points
          .map((p) => `${p.id}：${p.score}分 ${p.reason} ${p.evidence}`)
          .join('\n'),
        row.audit?.note,
        run.revision,
      ]);
      totals.set(row.paperId, (totals.get(row.paperId) ?? 0) + score);
    }
    const summary = workbook.addWorksheet('学生总分');
    summary.addRow(['卷号', '学号', '姓名', '总分', '满分']);
    for (const [paperId, score] of totals) {
      summary.addRow([
        run.rows.find((row) => row.paperId === paperId)?.paperCode,
        identity(paperId)?.studentId,
        identity(paperId)?.name,
        Number(score.toFixed(6)),
        run.draft.questions.reduce((sum, q) => sum + q.maxScore, 0),
      ]);
    }
    for (const sheet of [detail, summary]) {
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
      sheet.getRow(1).font = { bold: true };
      sheet.columns.forEach((column) => {
        column.width = 16;
      });
    }
    for (const index of [8, 9, 10]) {
      detail.getColumn(index).width = 38;
      detail.getColumn(index).alignment = { wrapText: true, vertical: 'top' };
    }
    await workbook.xlsx.writeFile(target);
  }
}
