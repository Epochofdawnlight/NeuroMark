import sharp from 'sharp';
import type {
  ChoiceGrid,
  ChoiceOption,
  HistoryGrade,
  HistoryQuestion,
  HistoryRegion,
  OpticalMark,
} from '@preload/history';

export const choiceOptions: ChoiceOption[] = ['A', 'B', 'C', 'D'];

export function choiceRegion(
  grid: ChoiceGrid,
  id: string,
): HistoryRegion | undefined {
  const index = grid.questionIds.indexOf(id);
  if (index < 0) return undefined;
  const { region, orientation } = grid;
  const length = grid.questionIds.length;
  if (orientation === 'rows') {
    const height = region.height / length;
    return { ...region, y: region.y + index * height, height };
  }
  const width = region.width / length;
  return { ...region, x: region.x + index * width, width };
}

export function classifyOpticalMarks(marks: number[]): OpticalMark {
  const ranked = marks
    .map((ink, index) => ({ ink, option: choiceOptions[index] }))
    .sort((a, b) => b.ink - a.ink);
  const [first, second] = ranked;
  if (first.ink < 0.025) return { status: 'blank', marks };
  if (second.ink >= 0.11 && second.ink >= first.ink * 0.48)
    return { status: 'multiple', marks };
  if (first.ink < 0.11 || second.ink > 0.045)
    return { status: 'uncertain', marks };
  return { status: 'single', selected: first.option, marks };
}

export async function readOpticalMarks(
  image: string,
  orientation: ChoiceGrid['orientation'],
): Promise<OpticalMark> {
  const buffer = Buffer.from(image.split(',')[1], 'base64');
  const raw = await decodeOpticalGrid(buffer);
  const mark = readOpticalGridCell(raw, orientation, 0, 1);
  if (!mark) throw new Error('填涂题框过小，无法辨认选项。');
  return mark;
}

export function decodeOpticalGrid(buffer: Buffer) {
  return sharp(buffer)
    .grayscale()
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

export function readOpticalGridCell(
  { data, info }: Awaited<ReturnType<typeof decodeOpticalGrid>>,
  orientation: ChoiceGrid['orientation'],
  index: number,
  count: number,
): OpticalMark | undefined {
  const { width, height, channels } = info;
  const horizontal = orientation === 'rows';
  const cell = (horizontal ? width : height) / 4;
  const questionAxis = horizontal ? height : width;
  const offset = Math.floor((index * questionAxis) / count);
  const across = Math.ceil(((index + 1) * questionAxis) / count) - offset;
  if (cell < 6 || across < 6) return undefined;
  const startAcross = offset + Math.ceil(across * 0.19);
  const endAcross = offset + Math.floor(across * 0.81);
  const marks = choiceOptions.map((_, option) => {
    const startAxis = Math.ceil((option + 0.2) * cell);
    const endAxis = Math.floor((option + 0.8) * cell);
    const pixels: number[] = [];
    for (let axis = startAxis; axis < endAxis; axis += 1) {
      for (let cross = startAcross; cross < endAcross; cross += 1) {
        const x = horizontal ? axis : cross;
        const y = horizontal ? cross : axis;
        pixels.push(data[(y * width + x) * channels]);
      }
    }
    if (!pixels.length) return 0;
    const sorted = pixels.slice().sort((a, b) => a - b);
    const background = sorted[Math.floor((sorted.length - 1) * 0.88)];
    const threshold = Math.max(90, Math.min(204, background - 35));
    return pixels.filter((value) => value < threshold).length / pixels.length;
  });
  return classifyOpticalMarks(marks);
}

export function gradeOpticalMark(
  question: HistoryQuestion,
  mark: OpticalMark,
): HistoryGrade | undefined {
  if (mark.status === 'multiple' || mark.status === 'uncertain')
    return undefined;
  const correct =
    mark.status === 'single' && mark.selected === question.answerKey;
  const score = correct ? question.maxScore : 0;
  const comment =
    mark.status === 'blank'
      ? `本题未填涂，参考答案为 ${question.answerKey}。`
      : correct
        ? `选择 ${mark.selected} 正确。`
        : `选择 ${mark.selected}，参考答案为 ${question.answerKey}。`;
  return {
    score,
    comment,
    points: [
      { id: 'choice', score, evidence: mark.selected ?? '', reason: comment },
    ],
  };
}
