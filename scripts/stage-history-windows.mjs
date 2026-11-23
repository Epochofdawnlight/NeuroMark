import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [electronArg, resourcesArg, stageArg] = process.argv.slice(2);
if (!electronArg || !resourcesArg || !stageArg) {
  throw new Error(
    'Usage: node scripts/stage-history-windows.mjs <NeuroMark.exe> <unpacked resources dir> <new stage dir>',
  );
}
const executable = path.resolve(electronArg);
const runtime = path.dirname(executable);
const resources = path.resolve(resourcesArg);
const stage = path.resolve(stageArg);
const referenceApp = path.join(resources, 'app');
const targetApp = path.join(stage, 'resources', 'app');
const version = '1.4.0';
const appId = 'io.github.epochofdawnlight.historygrading';
if (fs.existsSync(stage))
  throw new Error('Choose an empty, newly named staging directory.');

const mainSource = fs.readFileSync(
  path.join(project, 'dist-electron/main/index.js'),
  'utf8',
);
const mainImports = [...mainSource.matchAll(/^import .*? from "([^"]+)";$/gm)]
  .map((match) => match[1])
  .filter((name) => name !== 'electron' && !name.startsWith('node:'));
if (!mainImports.includes('better-sqlite3') || !mainImports.includes('sharp')) {
  throw new Error(
    'Build the Electron application before running the staging script.',
  );
}

function packageName(name) {
  return name.startsWith('@')
    ? name.split('/').slice(0, 2).join('/')
    : name.split('/')[0];
}

function findPackage(name, origin) {
  let current = origin;
  while (
    current === referenceApp ||
    current.startsWith(referenceApp + path.sep)
  ) {
    const candidate = path.join(current, 'node_modules', packageName(name));
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    current = path.dirname(current);
  }
}

const included = new Set();
function include(name, origin, optional = false) {
  const folder = findPackage(name, origin);
  if (!folder) {
    if (optional) return;
    throw new Error(`Missing Electron-compatible package: ${name}`);
  }
  if (included.has(folder)) return;
  included.add(folder);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(folder, 'package.json'), 'utf8'),
  );
  const optionalDeps = manifest.optionalDependencies ?? {};
  for (const dep of Object.keys(manifest.dependencies ?? {})) {
    include(dep, folder, Object.hasOwn(optionalDeps, dep));
  }
  for (const dep of Object.keys(optionalDeps)) include(dep, folder, true);
}
for (const name of mainImports) include(name, referenceApp);

fs.mkdirSync(targetApp, { recursive: true });
for (const entry of fs.readdirSync(runtime, { withFileTypes: true })) {
  if (
    entry.name === 'locales' ||
    (entry.isFile() && !entry.name.endsWith('.exe'))
  ) {
    fs.cpSync(path.join(runtime, entry.name), path.join(stage, entry.name), {
      recursive: true,
    });
  }
}
fs.copyFileSync(executable, path.join(stage, 'NeuroMark.exe'));
fs.copyFileSync(
  path.join(project, 'LICENSE'),
  path.join(stage, 'resources', 'LICENSE-NeuroMark.txt'),
);
for (const name of ['dist', 'dist-electron']) {
  fs.cpSync(path.join(project, name), path.join(targetApp, name), {
    recursive: true,
  });
}

for (const folder of included) {
  const destination = path.join(targetApp, path.relative(referenceApp, folder));
  fs.cpSync(folder, destination, {
    recursive: true,
    filter: (file) =>
      file === folder ||
      (path.basename(file) !== 'node_modules' &&
        !/\.(?:map|d\.ts|d\.cts|d\.mts)$/.test(file)),
  });
}

fs.writeFileSync(
  path.join(targetApp, 'package.json'),
  JSON.stringify(
    {
      name: 'neuromark-history-workflow',
      productName: 'NeuroMark',
      version,
      type: 'module',
      main: 'history-entry.cjs',
      license: 'MIT',
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(targetApp, 'history-entry.cjs'),
  `
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app } = require('electron');
const alternate = app.commandLine.getSwitchValue('user-data-dir');
const profile = alternate ? path.resolve(alternate) : path.join(app.getPath('appData'), 'HistoryGrading');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.setName('NeuroMark');
app.setAppUserModelId('${appId}');
if (!app.requestSingleInstanceLock()) app.quit();
else import(pathToFileURL(path.join(__dirname, 'dist-electron/main/index.js')).href)
  .catch((error) => { console.error(error); app.exit(1); });
`.trimStart(),
);
fs.writeFileSync(
  path.join(targetApp, 'dist-electron/main/index.js'),
  mainSource
    .replaceAll('"cn.bit-helper.neuromark"', JSON.stringify(appId))
    .replace('"NeuroMark Projects"', '"历史阅卷项目"'),
);
// Use the same runtime filenames for collision checks and uninstall.
const managedFiles = [
  ...fs
    .readdirSync(stage, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name),
  ...fs
    .readdirSync(path.join(stage, 'locales'))
    .map((name) => `locales\\${name}`),
  'resources\\LICENSE-NeuroMark.txt',
];
fs.writeFileSync(
  `${stage}.nsh`,
  [
    '!macro CheckRuntimeCollisions',
    ...managedFiles.map(
      (name) => `  IfFileExists "$INSTDIR\\${name}" target_collision`,
    ),
    '!macroend',
    '!macro RemoveRuntimeFiles',
    ...managedFiles.flatMap((name) => [
      `  IfFileExists "$INSTDIR\\${name}" 0 +2`,
      `  Delete "$INSTDIR\\${name}"`,
    ]),
    '!macroend',
  ].join('\n') + '\n',
);
console.log(
  `Staged NeuroMark ${version} with ${included.size} Electron runtime packages.`,
);
