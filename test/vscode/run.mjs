// Builds test/vscode/suite.ts and runs it inside a real VS Code (an isolated profile, no
// other extensions). Usage: npm run test:vscode [-- /path/to/Code]
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.join(root, 'out', 'vscode-test');
const executable =
  process.argv[2] ??
  process.env.VSCODE_EXECUTABLE ??
  '/Applications/Visual Studio Code.app/Contents/MacOS/Code';

if (!fs.existsSync(executable)) {
  console.error(`VS Code not found at ${executable}. Pass its path as an argument or set VSCODE_EXECUTABLE.`);
  process.exit(2);
}

await esbuild.build({
  entryPoints: [path.join(root, 'test/vscode/suite.ts')],
  outfile: path.join(outDir, 'suite.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode', 'bufferutil', 'utf-8-validate'],
  logLevel: 'warning',
});

// The suite registers the beaconbob:// provider itself, so it runs from an empty stub
// extension rather than the real one (which would claim the same scheme).
const stubExtension = path.join(outDir, 'stub-extension');
fs.mkdirSync(stubExtension, { recursive: true });
fs.writeFileSync(
  path.join(stubExtension, 'package.json'),
  JSON.stringify({ name: 'beaconbob-test-host', publisher: 'test', version: '0.0.0', engines: { vscode: '^1.90.0' } }),
);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'beaconbob-vscode-user-'));
const report = path.join(userData, 'report.txt');
const child = spawn(
  executable,
  [
    `--extensionDevelopmentPath=${stubExtension}`,
    `--extensionTestsPath=${path.join(outDir, 'suite.js')}`,
    `--user-data-dir=${userData}`,
    `--extensions-dir=${path.join(userData, 'extensions')}`,
    '--disable-extensions',
    '--disable-workspace-trust',
    '--skip-welcome',
    '--new-window',
  ],
  { stdio: 'inherit', env: { ...process.env, BEACONBOB_VSCODE_REPORT: report, ELECTRON_RUN_AS_NODE: undefined } },
);
const code = await new Promise((resolve) => child.on('exit', resolve));
if (fs.existsSync(report)) console.log(`\n${fs.readFileSync(report, 'utf8')}\n`);
fs.rmSync(userData, { recursive: true, force: true });
process.exit(code ?? 1);
