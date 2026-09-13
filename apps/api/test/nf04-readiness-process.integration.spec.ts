import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';

type ChildResult = Readonly<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}>;

describe('NF-04 readiness child-process lifecycle', () => {
  let temporaryRoot: string;
  let compiledReadinessPath: string;

  beforeAll(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'mh-nf04-readiness-'));
    await mkdir(temporaryRoot, { recursive: true });
    const source = await readFile(
      resolve(process.cwd(), 'src', 'nf04', 'nf04-readiness.ts'),
      'utf8',
    );
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
      fileName: 'nf04-readiness.ts',
    }).outputText;
    compiledReadinessPath = join(temporaryRoot, 'nf04-readiness.cjs');
    await writeFile(compiledReadinessPath, compiled, 'utf8');
  });

  afterAll(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('stays alive after an initial readiness failure and completes after a later success', async () => {
    const result = await runReadinessChild(compiledReadinessPath, 'eventual-success');

    expect(result).toEqual({
      exitCode: 0,
      stdout: '{"event":"readiness_completed","attempts":2}\n',
      stderr: '',
    });
  });

  it('stays alive through the bounded deadline and exits through the failure branch', async () => {
    const result = await runReadinessChild(compiledReadinessPath, 'deadline');

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^\{"event":"readiness_failed","attempts":\d+\}\n$/u);
    expect(
      Number.parseInt(/"attempts":(\d+)/u.exec(result.stderr)?.[1] ?? '0', 10),
    ).toBeGreaterThan(1);
  });
});

function runReadinessChild(
  readinessModulePath: string,
  mode: 'eventual-success' | 'deadline',
): Promise<ChildResult> {
  const program = String.raw`
const { waitForNf04Readiness } = require(process.argv[1]);
const mode = process.argv[2];
let attempts = 0;
waitForNf04Readiness({
  timeoutMs: mode === 'eventual-success' ? 500 : 80,
  retryIntervalMs: 20,
  probe: async () => {
    attempts += 1;
    return mode === 'eventual-success' && attempts === 2;
  },
}).then(() => {
  process.stdout.write(JSON.stringify({ event: 'readiness_completed', attempts }) + '\n');
}).catch(() => {
  process.stderr.write(JSON.stringify({ event: 'readiness_failed', attempts }) + '\n');
  process.exitCode = 1;
});
`;

  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, ['-e', program, readinessModulePath, mode], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      rejectChild(new Error('NF-04 readiness child process did not settle within its test bound'));
    }, 2_000);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectChild(error);
    });
    child.once('close', (exitCode) => {
      clearTimeout(timeout);
      resolveChild({ exitCode, stdout, stderr });
    });
  });
}
