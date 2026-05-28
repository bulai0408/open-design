import type http from 'node:http';

import { execFile } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PLUGIN_UNINSTALL_NOT_FOUND_CODE,
  PluginUninstallOutcomeSchema,
} from '@open-design/contracts';

import { startServer } from '../src/server.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const CLI_SRC = path.join(__dirname, '../src/cli.ts');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const execFileP = promisify(execFile);

let baseUrl: string;
let server: http.Server;
let shutdown: (() => Promise<void> | void) | undefined;

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

afterAll(async () => {
  await Promise.resolve(shutdown?.());
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function runCli(args: string[]): Promise<{
  stdout: string;
  stderr: string;
}> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OD_DAEMON_URL: baseUrl,
  };
  delete env.NODE_OPTIONS;
  return await execFileP(process.execPath, [TSX_CLI, CLI_SRC, ...args], {
    cwd: path.join(__dirname, '..'),
    env,
    timeout: 20_000,
    maxBuffer: 10 * 1024 * 1024,
  }) as { stdout: string; stderr: string };
}

describe('POST /api/plugins/:id/uninstall', () => {
  it('returns the shared typed not-found outcome for a no-op uninstall', async () => {
    const resp = await fetch(`${baseUrl}/api/plugins/not-installed-plugin/uninstall`, {
      method: 'POST',
    });

    expect(resp.status).toBe(404);
    const body = await resp.json();
    const parsed = PluginUninstallOutcomeSchema.parse(body);
    expect(parsed).toMatchObject({
      ok: false,
      code: PLUGIN_UNINSTALL_NOT_FOUND_CODE,
      notFound: true,
      warnings: [],
    });
  });

  it('treats the shared typed not-found outcome as a no-op in the CLI', async () => {
    const result = await runCli([
      'plugin',
      'uninstall',
      'not-installed-plugin',
    ]);

    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe('[uninstall] no-op');
  });
});
