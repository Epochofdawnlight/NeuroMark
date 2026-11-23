import { describe, expect, it } from 'vitest';
import {
  buildTrialReport,
  scoreHistoryAnswer,
} from '@main/services/history/historyRules';
import type { HistoryQuestion, HistoryRow } from '@preload/history';

const question: HistoryQuestion = {
  id: '17(1)',
  prompt: '概括原因',
  maxScore: 4,
  regions: [],
  criteria: [
    { id: 'a', text: '制度变化', maxScore: 2 },
    { id: 'b', text: '经济发展', maxScore: 2 },
  ],
};

describe('history grading', () => {
  it('rejects awarding points on evidence absent from the transcription', () => {
    expect(() =>
      scoreHistoryAnswer(question, '工商业发展', {
        points: [
          { id: 'a', score: 2, evidence: '制度变化', reason: '命中' },
          { id: 'b', score: 0, evidence: '', reason: '缺失' },
        ],
        comment: '补充原因',
      }),
    ).toThrow('原文');
  });

  it('keeps unreadable and failed answers outside the score denominator', () => {
    const grade = scoreHistoryAnswer(question, '工商业发展', {
      points: [
        { id: 'a', score: 0, evidence: '', reason: '缺失' },
        { id: 'b', score: 2, evidence: '工商业发展', reason: '命中' },
      ],
      comment: '补充制度变化',
    });
    const rows = [
      { questionId: question.id, status: 'scored', grade },
      { questionId: question.id, status: 'blank' },
      { questionId: question.id, status: 'unreadable' },
      { questionId: question.id, status: 'error' },
    ] as HistoryRow[];
    expect(buildTrialReport([question], rows)[0]).toMatchObject({
      sampled: 4,
      graded: 2,
      blank: 1,
      unreadable: 1,
      failed: 1,
      mean: 1,
      points: [
        { id: 'a', hit: 0 },
        { id: 'b', hit: 1 },
      ],
    });
  });
});
