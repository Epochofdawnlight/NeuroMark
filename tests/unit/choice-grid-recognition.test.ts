import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import {
  readChoiceGrid,
  readHandwrittenChoiceGrids,
} from '@main/services/history/choiceGridRecognition';
import type { HistoryConnection } from '@main/services/history/historyModels';

const config: HistoryConnection = {
  model: 'vision',
  hasKey: true,
  baseUrl: 'https://fixture.invalid/v1',
  apiKey: 'fake',
};

async function syntheticGrid(orientation: 'rows' | 'columns') {
  const rows = orientation === 'rows';
  const width = rows ? 100 : 60;
  const height = rows ? 60 : 100;
  const mark = (option: number, question: number) => {
    const x = rows ? option * 25 + 7 : question * 20 + 3;
    const y = rows ? question * 20 + 3 : option * 25 + 7;
    return `<rect x="${x}" y="${y}" width="${rows ? 12 : 14}" height="${rows ? 14 : 12}" fill="black"/>`;
  };
  const svg =
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="${width}" height="${height}" fill="white"/>
    ${mark(1, 0)}${mark(0, 2)}${mark(3, 2)}
  </svg>`);
  return sharp(svg).png().toBuffer();
}

afterEach(() => vi.unstubAllGlobals());

it.each(['rows', 'columns'] as const)(
  'reads every %s cell from the local grid',
  async (orientation) => {
    const image = await syntheticGrid(orientation);

    const result = await readChoiceGrid(image, orientation, ['5', '7', '9'], {
      mode: 'omr',
    });

    expect([...result.keys()]).toEqual(['5', '7', '9']);
    expect(result.get('5')).toMatchObject({ status: 'single', selected: 'B' });
    expect(result.get('7')).toMatchObject({
      status: 'blank',
      marks: [0, 0, 0, 0],
    });
    expect(result.get('9')).toMatchObject({ status: 'multiple' });
  },
);

it('leaves undersized OMR cells and duplicate requested IDs uncertain', async () => {
  const image = await syntheticGrid('rows');
  const result = await readChoiceGrid(
    image,
    'rows',
    ['repeat', '2', 'repeat'],
    { mode: 'omr' },
  );
  expect(result.get('repeat')).toEqual({ status: 'uncertain', marks: [] });
  expect(result.get('2')?.status).toBe('blank');

  const tiny = await sharp({
    create: { width: 20, height: 20, channels: 3, background: 'white' },
  })
    .png()
    .toBuffer();
  const small = await readChoiceGrid(tiny, 'rows', ['1', '2'], { mode: 'omr' });
  expect([...small.values()]).toEqual(
    Array(2).fill({ status: 'uncertain', marks: [] }),
  );
});

it('reads a handwritten grid in one request and isolates missing, invalid and duplicate rows', async () => {
  const image = await syntheticGrid('rows');
  const choices = [
    { id: '5', status: 'multiple', options: ['A', 'B'] },
    { id: '3', status: 'single', options: ['B'] },
    { id: '3', status: 'invalid' },
    { id: '2', status: 'blank', options: [] },
    { id: '1', status: 'single', options: ['D'] },
    { id: '4', status: 'single', options: ['E'] },
    { id: 'not-requested', status: 'single', options: ['A'] },
  ];
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({
      choices: [
        {
          message: { content: JSON.stringify({ choices }) },
          finish_reason: 'stop',
        },
      ],
    }),
  );
  vi.stubGlobal('fetch', fetch);
  const ids = ['1', '2', '3', '4', '5', '6'];

  const result = await readChoiceGrid(image, 'columns', ids, {
    mode: 'handwritten',
    config,
  });

  expect(fetch).toHaveBeenCalledTimes(1);
  const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
  expect(body.messages[1].content).toEqual([
    {
      type: 'text',
      text: JSON.stringify({
        groups: [{ imageIndex: 1, orientation: 'columns', questionIds: ids }],
      }),
    },
    {
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${image.toString('base64')}` },
    },
  ]);
  expect([...result.entries()]).toEqual([
    ['1', { status: 'single', selected: 'D', marks: [] }],
    ['2', { status: 'blank', marks: [] }],
    ['3', { status: 'uncertain', marks: [] }],
    ['4', { status: 'uncertain', marks: [] }],
    ['5', { status: 'multiple', marks: [] }],
    ['6', { status: 'uncertain', marks: [] }],
  ]);
});

it('reads non-contiguous handwritten grids in a single request with matching image indices', async () => {
  const rows = await syntheticGrid('rows');
  const columns = await syntheticGrid('columns');
  const choices = [
    { id: '21', status: 'single', options: ['C'] },
    { id: '6', status: 'single', options: ['B'] },
    { id: '20', status: 'blank', options: [] },
  ];
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({
      choices: [
        {
          message: { content: JSON.stringify({ choices }) },
          finish_reason: 'stop',
        },
      ],
    }),
  );
  vi.stubGlobal('fetch', fetch);

  const result = await readHandwrittenChoiceGrids(
    [
      { buffer: rows, orientation: 'rows', questionIds: ['6'] },
      { buffer: columns, orientation: 'columns', questionIds: ['20', '21'] },
    ],
    config,
  );

  expect(fetch).toHaveBeenCalledTimes(1);
  const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
  const [layout, ...images] = body.messages[1].content;
  expect(JSON.parse(layout.text)).toEqual({
    groups: [
      { imageIndex: 1, orientation: 'rows', questionIds: ['6'] },
      { imageIndex: 2, orientation: 'columns', questionIds: ['20', '21'] },
    ],
  });
  expect(images).toEqual(
    [rows, columns].map((buffer) => ({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${buffer.toString('base64')}` },
    })),
  );
  expect([...result.entries()]).toEqual([
    ['6', { status: 'single', selected: 'B', marks: [] }],
    ['20', { status: 'blank', marks: [] }],
    ['21', { status: 'single', selected: 'C', marks: [] }],
  ]);
});
