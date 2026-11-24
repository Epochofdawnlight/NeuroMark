import { z } from 'zod';
import type { ChoiceGrid, OpticalMark } from '@preload/history';
import {
  handwrittenChoiceInstructions,
  interpretHandwrittenChoice,
  requestHistoryJson,
  type HistoryConnection,
} from './historyModels';
import { decodeOpticalGrid, readOpticalGridCell } from './opticalMarks';

type ChoiceGridReadOptions =
  | { mode: 'omr' }
  | { mode: 'handwritten'; config: HistoryConnection };

interface HandwrittenGrid {
  buffer: Buffer;
  orientation: ChoiceGrid['orientation'];
  questionIds: readonly string[];
}

const responseSchema = z.object({ choices: z.array(z.unknown()) });
const rowSchema = z.object({ id: z.string(), options: z.unknown().optional() });

function uncertain(): OpticalMark {
  return { status: 'uncertain', marks: [] };
}

export async function readChoiceGrid(
  buffer: Buffer,
  orientation: ChoiceGrid['orientation'],
  questionIds: readonly string[],
  options: ChoiceGridReadOptions,
): Promise<Map<string, OpticalMark>> {
  if (options.mode === 'handwritten')
    return readHandwrittenChoiceGrids(
      [{ buffer, orientation, questionIds }],
      options.config,
    );

  const marks = new Map<string, OpticalMark>();
  if (!questionIds.length) return marks;
  const raw = await decodeOpticalGrid(buffer);
  questionIds.forEach((id, index) => {
    const result = readOpticalGridCell(
      raw,
      orientation,
      index,
      questionIds.length,
    );
    marks.set(
      id,
      !id.trim() || marks.has(id) ? uncertain() : (result ?? uncertain()),
    );
  });
  return marks;
}

export async function readHandwrittenChoiceGrids(
  grids: readonly HandwrittenGrid[],
  config: HistoryConnection,
): Promise<Map<string, OpticalMark>> {
  const marks = new Map<string, OpticalMark>();
  const invalidIds = new Set<string>();
  for (const { questionIds } of grids) {
    for (const id of questionIds) {
      if (!id.trim() || marks.has(id)) invalidIds.add(id);
      marks.set(id, uncertain());
    }
  }
  if (marks.size === invalidIds.size) return marks;
  const groups = grids.map(({ orientation, questionIds }, index) => ({
    imageIndex: index + 1,
    orientation,
    questionIds,
  }));
  return requestHistoryJson(
    config,
    '这些图是同一份卷子的手写选择题作答格。groups 的 imageIndex 从 1 开始，和随后图片的顺序对应。每张图只识别其对应的 questionIds，各题号与格子按位置一一对应。' +
      'orientation 为 rows 时按从上到下的行排列，为 columns 时按从左到右的列排列。' +
      '空格也占一个位置，禁止跳过后把其他答案错配到该题。只检查每题对应的格，不把邻格的答案填进本格。' +
      '题号用于定位，按提供的 questionIds 原样返回，不把印刷题号或格外文字当作答案。' +
      handwrittenChoiceInstructions +
      '每个题号返回一次，只输出 JSON {"choices":[{"id":"题号","status":"single|blank|multiple|uncertain","options":["A"]}]}。',
    [
      { type: 'text', text: JSON.stringify({ groups }) },
      ...grids.map(({ buffer }) => ({
        type: 'image_url' as const,
        image_url: {
          url: `data:image/png;base64,${buffer.toString('base64')}`,
        },
      })),
    ],
    {
      operation: '手写选择题整组识别',
      parseResponse: (result) => {
        const parsed = responseSchema.safeParse(result);
        if (!parsed.success) return marks;
        const seen = new Set<string>();
        for (const row of parsed.data.choices) {
          const entry = rowSchema.safeParse(row);
          if (!entry.success) continue;
          const { id, options } = entry.data;
          if (!marks.has(id) || invalidIds.has(id)) continue;
          if (seen.has(id)) {
            marks.set(id, uncertain());
            continue;
          }
          seen.add(id);
          if (!Array.isArray(options)) continue;
          try {
            marks.set(id, interpretHandwrittenChoice(row));
          } catch (error) {
            if (!(error instanceof z.ZodError)) throw error;
          }
        }
        return marks;
      },
    },
  );
}
