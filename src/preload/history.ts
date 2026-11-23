export interface HistoryRegion {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HistoryCriterion {
  id: string;
  text: string;
  maxScore: number;
}

export interface HistoryQuestion {
  id: string;
  prompt: string;
  maxScore: number;
  regions: HistoryRegion[];
  criteria: HistoryCriterion[];
}

export interface HistoryDraft {
  reference: string;
  material: string;
  questions: HistoryQuestion[];
}

export interface HistoryEndpoint {
  baseUrl: string;
  model: string;
  hasKey: boolean;
}

export interface HistoryProviderSettings {
  recognition: HistoryEndpoint;
  grading: HistoryEndpoint;
}

export type HistoryProviderInput = Record<
  keyof HistoryProviderSettings,
  Pick<HistoryEndpoint, 'baseUrl' | 'model'> & { apiKey?: string }
>;

export interface HistoryPoint {
  id: string;
  score: number;
  evidence: string;
  reason: string;
}

export interface HistoryGrade {
  score: number;
  points: HistoryPoint[];
  comment: string;
}

export interface HistorySource {
  file: string;
  version: number | null;
  region: HistoryRegion;
}

export interface HistoryRow {
  paperId: string;
  paperCode: string;
  questionId: string;
  sources: HistorySource[];
  cacheKey: string;
  status: 'pending' | 'scored' | 'blank' | 'unreadable' | 'error';
  transcript?: string;
  grade?: HistoryGrade;
  error?: string;
  audit?: { at: string; score: number; comment: string; note: string };
  edits?: (
    | { kind: 'transcript'; at: string; previous: string; current: string }
    | {
        kind: 'score';
        at: string;
        score: number;
        comment: string;
        note: string;
      }
  )[];
}

export interface HistoryRun {
  id: string;
  kind: 'trial' | 'formal';
  revision: number;
  providerRevision: number;
  providers: HistoryProviderSettings;
  draft: HistoryDraft;
  sampledPapers: number;
  totalPapers: number;
  rows: HistoryRow[];
  status: 'running' | 'paused' | 'review' | 'confirmed';
  createdAt: string;
  identities?: Record<string, { studentId: string; name: string }>;
}

export interface HistoryReport {
  questionId: string;
  sampled: number;
  graded: number;
  blank: number;
  unreadable: number;
  failed: number;
  mean: number | null;
  distribution: { score: number; count: number }[];
  points: { id: string; text: string; hit: number; full: number }[];
  examples: { paperCode: string; transcript: string; comment: string }[];
}

export interface HistorySnapshot {
  revision: number;
  draft: HistoryDraft;
  providers: HistoryProviderSettings;
  approvedTrialId?: string;
  trial?: HistoryRun;
  formal?: HistoryRun;
  report: HistoryReport[];
  pastRuns: Omit<HistoryRun, 'rows' | 'draft'>[];
  identities: Record<string, { studentId: string; name: string }>;
}

export interface HistoryRowRef {
  runId: string;
  paperId: string;
  questionId: string;
}

export interface HistoryApi {
  get: (projectId: string) => Promise<HistorySnapshot>;
  getRun: (projectId: string, runId: string) => Promise<HistoryRun>;
  bindStudent: (
    projectId: string,
    paperId: string,
    studentId: string,
    name: string,
  ) => Promise<void>;
  saveProviders: (
    projectId: string,
    input: HistoryProviderInput,
  ) => Promise<void>;
  testProvider: (
    projectId: string,
    role: keyof HistoryProviderSettings,
  ) => Promise<void>;
  saveDraft: (
    projectId: string,
    revision: number,
    draft: HistoryDraft,
  ) => Promise<void>;
  start: (
    projectId: string,
    kind: HistoryRun['kind'],
    sampleSize?: number,
    repeat?: boolean,
  ) => Promise<void>;
  resume: (projectId: string, runId: string) => Promise<void>;
  preview: (projectId: string, ref: HistoryRowRef) => Promise<string[]>;
  correctTranscript: (
    projectId: string,
    ref: HistoryRowRef,
    text: string,
  ) => Promise<void>;
  audit: (
    projectId: string,
    ref: HistoryRowRef,
    score: number,
    comment: string,
    note: string,
  ) => Promise<void>;
  approveTrial: (projectId: string, runId: string) => Promise<void>;
  confirmFormal: (projectId: string, runId: string) => Promise<void>;
  export: (projectId: string, runId: string, target: string) => Promise<void>;
}
