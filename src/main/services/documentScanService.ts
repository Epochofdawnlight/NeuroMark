import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';
import { app } from 'electron';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import sharp, { type Sharp } from 'sharp';
import type { CornerPoint } from '@preload/contracts';
import { hasPaperBoundary } from './scanPaperBoundary';

const require = createRequire(import.meta.url);

interface NativeScanResult {
  sourceWidth: number;
  sourceHeight: number;
  scannedWidth: number;
  scannedHeight: number;
  scannedOutputPath: string;
  overlayOutputPath: string;
  corners: Array<{ x: number; y: number }>;
  detectedCorners: Array<{ x: number; y: number }>;
  debugOutputPaths: string[];
}

interface NativeScannerInstance {
  scanDocument: (options: {
    inputPath: string;
    scannedOutputPath: string;
    overlayOutputPath?: string;
    debugOutputPrefix?: string;
    writeDebugImages?: boolean;
    applyPostProcess?: boolean;
    scanMarginRatio?: number;
  }) => Promise<NativeScanResult>;
}

interface NativeScanModule {
  createScanner: (options: { modelPath: string }) => NativeScannerInstance;
}

export interface ScanDocumentResult {
  scannedPath: string;
  debugPreviewPath: string;
  cornersPath: string;
  corners: CornerPoint[];
}

interface ProcessDocumentImageOptions {
  writeDebugArtifacts?: boolean;
  applyPostProcess?: boolean;
  skipScanProcessing?: boolean;
  scanMarginRatio?: number;
}

let scannerPromise: Promise<NativeScannerInstance> | null = null;

function getPlatformArtifactDir(): string {
  return `${process.platform}-${process.arch}`;
}

function getProjectRoot(): string {
  let currentDir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (fs.pathExistsSync(path.join(currentDir, 'package.json'))) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return app.getAppPath();
    }

    currentDir = parentDir;
  }
}

function resolveNativeAddonPath(): string {
  const artifactDir = getPlatformArtifactDir();
  if (app.isPackaged) {
    return path.join(
      process.resourcesPath,
      'native',
      artifactDir,
      'scancpp_node.node',
    );
  }

  return path.join(
    getProjectRoot(),
    'build',
    'native',
    artifactDir,
    'scancpp_node.node',
  );
}

function resolveModelPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'models', 'u2netp.onnx');
  }

  return path.join(
    getProjectRoot(),
    'src-native',
    'scancpp',
    'models',
    'u2netp.onnx',
  );
}

function toCornerPoints(
  corners: Array<{ x: number; y: number }>,
): CornerPoint[] {
  return corners.map((point) => ({
    x: Math.round(point.x),
    y: Math.round(point.y),
  }));
}

function createBoundsFromCorners(corners: CornerPoint[]) {
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);

  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

async function getScanner(): Promise<NativeScannerInstance> {
  if (!scannerPromise) {
    scannerPromise = (async () => {
      const addonPath = resolveNativeAddonPath();
      const modelPath = resolveModelPath();

      if (!(await fs.pathExists(addonPath))) {
        throw new Error(
          `未找到扫描原生模块：${addonPath}。请先执行 npm run build:native。`,
        );
      }

      if (!(await fs.pathExists(modelPath))) {
        throw new Error(`未找到扫描模型文件：${modelPath}`);
      }

      const addon = require(addonPath) as NativeScanModule;
      return addon.createScanner({ modelPath });
    })().catch((error) => {
      scannerPromise = null;
      throw error;
    });
  }

  return scannerPromise;
}

function shouldWriteDebugArtifacts(
  options?: ProcessDocumentImageOptions,
): boolean {
  if (typeof options?.writeDebugArtifacts === 'boolean') {
    return options.writeDebugArtifacts;
  }

  return process.env.NEUROMARK_SCANCPP_DEBUG === '1';
}

async function openScanSource(inputPath: string): Promise<Sharp> {
  if (path.extname(inputPath).toLowerCase() !== '.bmp') return sharp(inputPath);
  // The canvas codec decodes BMP on platforms where libvips does not.
  const bitmap = await loadImage(await fs.readFile(inputPath));
  const canvas = createCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  return sharp(canvas.toBuffer('image/png'));
}

async function writeFullPage(
  image: Sharp,
  scannedPath: string,
  debugPreviewPath: string,
) {
  const source = image.clone().rotate();
  const [scan] = await Promise.all([
    source.clone().png().toFile(scannedPath),
    source
      .clone()
      .flatten({ background: 'white' })
      .jpeg({ quality: 90 })
      .toFile(debugPreviewPath),
  ]);
  return scan;
}

export async function processDocumentImage(
  inputPath: string,
  scannedPath: string,
  debugPreviewPath: string,
  cornersPath: string,
  options?: ProcessDocumentImageOptions,
): Promise<ScanDocumentResult> {
  await fs.ensureDir(path.dirname(scannedPath));
  await fs.ensureDir(path.dirname(debugPreviewPath));
  await fs.ensureDir(path.dirname(cornersPath));
  const source = await openScanSource(inputPath);

  if (options?.skipScanProcessing) {
    await writeFullPage(source, scannedPath, debugPreviewPath);

    const corners: CornerPoint[] = [];
    await fs.writeJson(
      cornersPath,
      {
        scanner: 'passthrough',
        sourcePath: inputPath,
        scannedPath,
        skippedScanProcessing: true,
        applyPostProcess: false,
        scanMarginRatio: options?.scanMarginRatio ?? 1,
        generatedAt: new Date().toISOString(),
      },
      { spaces: 2 },
    );

    return {
      scannedPath,
      debugPreviewPath,
      cornersPath,
      corners,
    };
  }

  const scanner = await getScanner();
  const writeDebugArtifacts = shouldWriteDebugArtifacts(options);
  const debugOutputPrefix = writeDebugArtifacts
    ? path.join(
        path.dirname(cornersPath),
        `${path.basename(cornersPath, path.extname(cornersPath))}_native`,
      )
    : undefined;

  const staging = await fs.mkdtemp(
    path.join(path.dirname(cornersPath), '.scan-'),
  );
  const pendingScan = path.join(staging, 'scan.png');
  const pendingPreview = path.join(staging, 'preview.jpg');
  let nativeResult: NativeScanResult | undefined;
  let corrected: boolean;
  let fullPage: Awaited<ReturnType<typeof writeFullPage>> | undefined;
  try {
    nativeResult = await scanner
      .scanDocument({
        inputPath,
        scannedOutputPath: pendingScan,
        overlayOutputPath: pendingPreview,
        debugOutputPrefix,
        writeDebugImages: writeDebugArtifacts,
        applyPostProcess: options?.applyPostProcess ?? true,
        scanMarginRatio: options?.scanMarginRatio ?? 1,
      })
      .catch((error: unknown) => {
        if (
          error instanceof Error &&
          (error.message ===
            'No document contour found in the saliency mask.' ||
            error.message === 'Detected contour is too small to be a document.')
        )
          return undefined;
        throw error;
      });
    corrected = Boolean(
      nativeResult &&
      (await hasPaperBoundary(
        source.clone(),
        nativeResult.sourceWidth,
        nativeResult.sourceHeight,
        nativeResult.detectedCorners,
      )),
    );
    if (!corrected)
      fullPage = await writeFullPage(source, pendingScan, pendingPreview);
    await fs.move(pendingScan, scannedPath, { overwrite: true });
    await fs.move(pendingPreview, debugPreviewPath, { overwrite: true });
  } finally {
    await fs.remove(staging);
  }

  const detectedCorners = toCornerPoints(nativeResult?.detectedCorners ?? []);
  const corners =
    corrected && nativeResult ? toCornerPoints(nativeResult.corners) : [];

  await fs.writeJson(
    cornersPath,
    {
      scanner: 'scancpp-native',
      model: path.basename(resolveModelPath()),
      corners,
      bounds: corrected ? createBoundsFromCorners(corners) : undefined,
      decision: corrected ? 'perspective-corrected' : 'keep-full-page',
      detectedCorners,
      detectedBounds: detectedCorners.length
        ? createBoundsFromCorners(detectedCorners)
        : undefined,
      sourceWidth: nativeResult?.sourceWidth ?? fullPage?.width,
      sourceHeight: nativeResult?.sourceHeight ?? fullPage?.height,
      scannedWidth: fullPage?.width ?? nativeResult?.scannedWidth,
      scannedHeight: fullPage?.height ?? nativeResult?.scannedHeight,
      applyPostProcess: corrected && (options?.applyPostProcess ?? true),
      scanMarginRatio: options?.scanMarginRatio ?? 1,
      debugOutputPaths: nativeResult?.debugOutputPaths ?? [],
      generatedAt: new Date().toISOString(),
    },
    { spaces: 2 },
  );

  return {
    scannedPath,
    debugPreviewPath,
    cornersPath,
    corners,
  };
}
