import type {
  ExamCatalogItem,
  ExamRubricProposal,
  HistoryDraft,
} from './history';

export function normalizeExamId(id: string): string {
  return id.normalize('NFKC').trim().replace(/\s+/g, '');
}

export function mergeQuestionCatalog(
  draft: HistoryDraft,
  items: ExamCatalogItem[],
): HistoryDraft {
  const existing = new Map(
    draft.questions.map((q) => [normalizeExamId(q.id), q]),
  );
  const next = new Map(
    items.map((item) => [normalizeExamId(item.id), item.kind]),
  );
  next.delete('');
  const questions = [...next.entries()].map(([id, kind]) => {
    const previous = existing.get(id);
    return previous && (previous.kind ?? 'written') === kind
      ? { ...previous, id, kind }
      : { id, kind, prompt: '', maxScore: 0, regions: [], criteria: [] };
  });
  const work = draft.regionsByPaper ?? {};
  return {
    ...draft,
    phase: 'regions',
    questions,
    regionsByPaper: Object.fromEntries(
      Object.entries(work).map(([paper, overrides]) => [
        paper,
        Object.fromEntries(
          Object.entries(overrides)
            .filter(([id]) => next.get(normalizeExamId(id)) === 'written')
            .map(([id, regions]) => [normalizeExamId(id), regions]),
        ),
      ]),
    ),
    choiceGrids: draft.choiceGrids
      ?.map((grid) => ({
        ...grid,
        questionIds: grid.questionIds.filter((id) => next.get(id) === 'choice'),
      }))
      .filter((grid) => grid.questionIds.length),
  };
}

export function applyRubricProposal(
  draft: HistoryDraft,
  proposal: ExamRubricProposal,
): HistoryDraft {
  const updates = new Map(
    proposal.items.map((item) => [normalizeExamId(item.id), item]),
  );
  return {
    ...draft,
    phase: 'rubric',
    rubricIssues: [
      ...new Set([...(draft.rubricIssues ?? []), ...proposal.issues]),
    ],
    questions: draft.questions.map((question) => {
      const item = updates.get(question.id);
      if (!item) return question;
      return {
        ...question,
        prompt: item.prompt,
        maxScore: item.maxScore,
        criteria: item.criteria,
        answerKey: question.kind === 'choice' ? item.answerKey : undefined,
        reference: item.reference,
        source: item.source,
      };
    }),
  };
}
