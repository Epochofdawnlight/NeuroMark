import { z } from 'zod';
import type {
  HistoryDraft,
  HistoryGrade,
  HistoryQuestion,
  HistoryReport,
  HistoryRegion,
  HistoryRow,
} from '@preload/history';

const regionSchema = z
  .object({
    page: z.number().int().min(0),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .refine((r) => r.x + r.width <= 1.000001 && r.y + r.height <= 1.000001);

export const historyRegionsSchema = z.array(regionSchema).max(100);

const draftSchema = z.object({
  reference: z.string().trim(),
  material: z.string().trim(),
  regionsByPaper: z
    .record(z.string(), z.record(z.string(), historyRegionsSchema))
    .optional(),
  questions: z.array(
    z.object({
      id: z.string().trim().min(1),
      prompt: z.string().trim().min(1),
      maxScore: z.number().positive(),
      regions: historyRegionsSchema,
      criteria: z.array(
        z.object({
          id: z.string().trim().min(1),
          text: z.string().trim().min(1),
          maxScore: z.number().positive(),
        }),
      ),
    }),
  ),
});

const gradeSchema = z.object({
  points: z.array(
    z.object({
      id: z.string(),
      score: z.number().min(0),
      evidence: z.string().trim(),
      reason: z.string().trim().min(1),
    }),
  ),
  comment: z.string().trim().min(1),
});

export function validateHistoryDraft(input: HistoryDraft): HistoryDraft {
  const draft = draftSchema.parse(input);
  if (!draft.questions.length) throw new Error('请添加至少一道小题。');
  const ids = new Set(draft.questions.map((q) => q.id));
  if (ids.size !== draft.questions.length)
    throw new Error('小题题号必须唯一。');
  for (const q of draft.questions) {
    if (!q.criteria.length) {
      throw new Error(`${q.id} 需要至少一条评分细则。`);
    }
    const pointIds = new Set(q.criteria.map((c) => c.id));
    const total = q.criteria.reduce((sum, c) => sum + c.maxScore, 0);
    if (
      pointIds.size !== q.criteria.length ||
      Math.abs(total - q.maxScore) > 1e-6
    ) {
      throw new Error(
        `${q.id} 的细则编号必须唯一，且各项分值之和必须等于小题满分。`,
      );
    }
  }
  for (const regions of Object.values(draft.regionsByPaper ?? {})) {
    const invalid = Object.keys(regions).find((id) => !ids.has(id));
    if (invalid) throw new Error(`答题区域引用了未定义的题号 ${invalid}。`);
  }
  return draft;
}

export function regionsForQuestion(
  draft: HistoryDraft,
  paperId: string,
  question: HistoryQuestion,
): HistoryRegion[] {
  const byPaper = draft.regionsByPaper;
  const overrides =
    byPaper && Object.hasOwn(byPaper, paperId) ? byPaper[paperId] : undefined;
  return overrides && Object.hasOwn(overrides, question.id)
    ? overrides[question.id]
    : question.regions;
}

function normalizeEvidence(text: string): string {
  return text.normalize('NFKC').replace(/\s/g, '');
}

export function scoreHistoryAnswer(
  question: HistoryQuestion,
  transcript: string,
  input: unknown,
): HistoryGrade {
  const grade = gradeSchema.parse(input);
  const expected = new Map(question.criteria.map((c) => [c.id, c.maxScore]));
  const source = normalizeEvidence(transcript);
  if (grade.points.length !== expected.size)
    throw new Error('返回的评分项数量不符。');
  let score = 0;
  for (const point of grade.points) {
    const maximum = expected.get(point.id);
    if (maximum === undefined || point.score > maximum) {
      throw new Error('评分项重复、未知或分数超出上限。');
    }
    expected.delete(point.id);
    const evidence = normalizeEvidence(point.evidence);
    if (point.score > 0 && (!evidence || !source.includes(evidence))) {
      throw new Error('给分依据必须引用学生答案原文。');
    }
    score += point.score;
  }
  return { ...grade, score: Number(score.toFixed(6)) };
}

export function buildTrialReport(
  questions: HistoryQuestion[],
  rows: HistoryRow[],
): HistoryReport[] {
  return questions.map((q) => {
    const answers = rows.filter((row) => row.questionId === q.id);
    const distribution = new Map<number, number>();
    const scored = answers.filter((row) =>
      ['scored', 'blank'].includes(row.status),
    );
    let total = 0;
    for (const row of scored) {
      const score = row.grade?.score ?? 0;
      total += score;
      distribution.set(score, (distribution.get(score) ?? 0) + 1);
    }
    const ordered = scored
      .filter((row) => row.transcript && row.grade)
      .sort((a, b) => a.grade!.score - b.grade!.score);
    const examples = [
      ...new Set([
        ordered[0],
        ordered[Math.floor(ordered.length / 2)],
        ordered.at(-1),
      ]),
    ].flatMap((row) =>
      row?.grade && row.transcript
        ? [
            {
              paperCode: row.paperCode,
              transcript: row.transcript,
              comment: row.grade.comment,
            },
          ]
        : [],
    );
    return {
      questionId: q.id,
      sampled: answers.length,
      graded: scored.length,
      blank: answers.filter((row) => row.status === 'blank').length,
      unreadable: answers.filter((row) => row.status === 'unreadable').length,
      failed: answers.filter((row) => row.status === 'error').length,
      mean: scored.length ? total / scored.length : null,
      distribution: [...distribution]
        .sort(([a], [b]) => a - b)
        .map(([score, count]) => ({ score, count })),
      points: q.criteria.map((criterion) => {
        const scores = scored.map(
          (row) =>
            row.grade?.points.find((point) => point.id === criterion.id)
              ?.score ?? 0,
        );
        return {
          id: criterion.id,
          text: criterion.text,
          hit: scores.filter((value) => value > 0).length,
          full: scores.filter((value) => value === criterion.maxScore).length,
        };
      }),
      examples,
    };
  });
}
