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
  kind?: 'written' | 'choice';
  prompt: string;
  maxScore: number;
  regions: HistoryRegion[];
  criteria: HistoryCriterion[];
  answerKey?: ChoiceOption;
  reference?: string;
  source?: string;
}

export type ChoiceOption = 'A' | 'B' | 'C' | 'D';
export interface ChoiceGrid {
  id: string;
  region: HistoryRegion;
  questionIds: string[];
  orientation: 'rows' | 'columns';
}
export interface OpticalMark {
  status: 'single' | 'blank' | 'multiple' | 'uncertain';
  selected?: ChoiceOption;
  marks: number[];
}
export interface ExamCatalogItem {
  id: string;
  kind: 'written' | 'choice';
  page?: number;
}
export interface ExamRubricItem {
  id: string;
  prompt: string;
  maxScore: number;
  reference: string;
  source: string;
  criteria: HistoryCriterion[];
  answerKey?: ChoiceOption;
}
export interface ExamRubricProposal {
  message: string;
  issues: string[];
  items: ExamRubricItem[];
}
export interface RubricChatMessage {
  role: 'teacher' | 'assistant';
  text: string;
  attachments?: string[];
}
export interface ExamMaterialFile {
  name: string;
  data: Uint8Array;
}

export interface HistoryDraft {
  phase?: 'catalog' | 'regions' | 'rubric' | 'ready';
  fullPageRegionsConfirmed?: boolean;
  reference: string;
  material: string;
  questions: HistoryQuestion[];
  regionsByPaper?: Record<string, Record<string, HistoryRegion[]>>;
  choiceGrids?: ChoiceGrid[];
  rubricIssues?: string[];
  rubricChat?: RubricChatMessage[];
  rubricSuggestion?: ExamRubricProposal;
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

export type HistoryProviderRole = keyof HistoryProviderSettings;
export type HistoryEndpointInput = Pick<
  HistoryEndpoint,
  'baseUrl' | 'model'
> & {
  apiKey?: string;
};
export type HistoryProviderInput = Record<
  HistoryProviderRole,
  HistoryEndpointInput
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
  opticalMark?: OpticalMark;
  choiceOrientation?: ChoiceGrid['orientation'];
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
  providerSignature?: string;
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
  needsRegionReview: boolean;
  providers: HistoryProviderSettings;
  canAdoptProviders: boolean;
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
  discoverCatalog: (
    projectId: string,
    paperId: string,
    redactTop: number,
  ) => Promise<ExamCatalogItem[]>;
  readExamMaterials: (
    projectId: string,
    files: ExamMaterialFile[],
  ) => Promise<string>;
  proposeRubric: (
    projectId: string,
    draft: HistoryDraft,
    instruction: string,
  ) => Promise<ExamRubricProposal>;
  getDefaultProviders: () => Promise<HistoryProviderSettings>;
  saveDefaultProvider: (
    role: HistoryProviderRole,
    input: HistoryEndpointInput,
  ) => Promise<void>;
  testDefaultProvider: (role: HistoryProviderRole) => Promise<void>;
  adoptProviders: (projectId: string) => Promise<void>;
  previewRegions: (
    projectId: string,
    paperId: string,
    regions: HistoryRegion[],
  ) => Promise<string[]>;
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
