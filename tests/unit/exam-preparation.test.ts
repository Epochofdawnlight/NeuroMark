import { expect, it } from 'vitest';
import {
  classifyOpticalMarks,
  choiceRegion,
} from '@main/services/history/opticalMarks';
import { mergeQuestionCatalog } from '@main/services/history/examPreparation';
import type { HistoryDraft } from '@preload/history';

it('ignores repeated printed subquestion numbers without losing existing regions', () => {
  const area = { page: 0, x: 0.1, y: 0.3, width: 0.8, height: 0.3 };
  const old: HistoryDraft = {
    reference: '',
    material: '',
    questions: [
      {
        id: '37(1)',
        prompt: '旧题干',
        maxScore: 4,
        regions: [area],
        criteria: [],
      },
    ],
  };
  const draft = mergeQuestionCatalog(old, [
    { id: '37（1）', kind: 'written' },
    { id: '37(1)', kind: 'written' },
    { id: '1', kind: 'choice' },
  ]);
  expect(draft.questions.map((q) => q.id)).toEqual(['37(1)', '1']);
  expect(draft.questions[0].regions).toEqual([area]);
});

it('maps an A–D answer row within the choice grid and distinguishes ambiguous marks', () => {
  const grid = {
    id: 'g',
    questionIds: ['1', '2'],
    orientation: 'rows' as const,
    region: { page: 1, x: 0.1, y: 0.25, width: 0.8, height: 0.5 },
  };
  expect(choiceRegion(grid, '2')).toEqual({
    page: 1,
    x: 0.1,
    y: 0.5,
    width: 0.8,
    height: 0.25,
  });
  expect(classifyOpticalMarks([0, 0.55, 0.01, 0])).toMatchObject({
    status: 'single',
    selected: 'B',
  });
  expect(classifyOpticalMarks([0, 0.3, 0.28, 0])).toMatchObject({
    status: 'multiple',
  });
  expect(classifyOpticalMarks([0, 0.04, 0, 0])).toMatchObject({
    status: 'uncertain',
  });
  expect(classifyOpticalMarks([0, 0.002, 0, 0])).toMatchObject({
    status: 'blank',
  });
});
