import type http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const CLI_SRC = path.join(__dirname, '../src/cli.ts');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

describe('Phase 2C CLI wrappers', () => {
  let server: http.Server;
  let baseUrl: string;
  let shutdown: (() => Promise<void> | void) | undefined;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string;
      server: http.Server;
      shutdown?: () => Promise<void> | void;
    };
    baseUrl = started.url;
    server = started.server;
    shutdown = started.shutdown;
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await Promise.resolve(shutdown?.());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function makeFolder(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'od-cli-phase2c-'));
    tempDirs.push(dir);
    return dir;
  }

  async function runCli(
    args: string[],
    options: { input?: string; timeout?: number } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OD_DAEMON_URL: baseUrl,
    };
    delete env.NODE_OPTIONS;

    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [TSX_CLI, CLI_SRC, ...args], {
        cwd: path.join(__dirname, '..'),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`CLI timed out: od ${args.join(' ')}`));
      }, options.timeout ?? 20_000);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        reject(new Error(`od ${args.join(' ')} exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      });
      child.stdin.end(options.input ?? '');
    });
  }

  it('imports a folder and creates a conversation through the CLI', async () => {
    const folder = makeFolder();
    await writeFile(path.join(folder, 'index.html'), '<!doctype html>');

    const imported = await runCli(['project', 'import', folder, '--name', 'CLI Import', '--json']);
    const importBody = JSON.parse(imported.stdout) as {
      project: { id: string; name: string; metadata?: { importedFrom?: string } };
      conversationId: string;
      entryFile: string | null;
    };

    expect(importBody.project.id).toBeTruthy();
    expect(importBody.project.name).toBe('CLI Import');
    expect(importBody.project.metadata?.importedFrom).toBe('folder');
    expect(importBody.conversationId).toBeTruthy();
    expect(importBody.entryFile).toBe('index.html');

    const created = await runCli([
      'conversation',
      'new',
      importBody.project.id,
      '--title',
      'Follow-up',
      '--json',
    ]);
    const conversationBody = JSON.parse(created.stdout) as {
      conversation: { id: string; projectId: string; title: string | null };
    };

    expect(conversationBody.conversation.id).toBeTruthy();
    expect(conversationBody.conversation.projectId).toBe(importBody.project.id);
    expect(conversationBody.conversation.title).toBe('Follow-up');
  });

  it('prints unified diffs for project files and stdin comparisons', async () => {
    const folder = makeFolder();
    await writeFile(path.join(folder, 'a.txt'), 'one\ntwo\n');
    await writeFile(path.join(folder, 'b.txt'), 'one\nthree\n');
    const imported = await runCli(['project', 'import', folder, '--json']);
    const importBody = JSON.parse(imported.stdout) as { project: { id: string } };

    const fileDiff = await runCli(['files', 'diff', importBody.project.id, 'a.txt', 'b.txt']);
    expect(fileDiff.stdout).toContain('--- a/a.txt');
    expect(fileDiff.stdout).toContain('+++ b/b.txt');
    expect(fileDiff.stdout).toContain('@@');
    expect(fileDiff.stdout).toContain('-two');
    expect(fileDiff.stdout).toContain('+three');

    const stdinDiff = await runCli(
      ['files', 'diff', importBody.project.id, 'a.txt', '--against', '-'],
      { input: 'one\nfour\n' },
    );
    expect(stdinDiff.stdout).toContain('--- a/a.txt');
    expect(stdinDiff.stdout).toContain('+++ b/-');
    expect(stdinDiff.stdout).toContain('-two');
    expect(stdinDiff.stdout).toContain('+four');
  });
});
