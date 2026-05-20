import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const daemonRoot = fileURLToPath(new URL('..', import.meta.url));
const cliEntry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

describe('CLI startup boundaries', () => {
  it('does not import daemon startup code for media client commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'od-cli-media-'));
    const dataDir = join(root, 'data');
    await mkdir(dataDir);
    await chmod(dataDir, 0o500);

    try {
      await execFileAsync(
        process.execPath,
        [
          '--import',
          'tsx',
          cliEntry,
          'media',
          'generate',
          '--project',
          'repro',
          '--surface',
          'image',
          '--model',
          'gpt-image-2',
          '--prompt',
          'test',
          '--daemon-url',
          'http://127.0.0.1:59999',
        ],
        {
          cwd: daemonRoot,
          env: {
            ...process.env,
            OD_DATA_DIR: dataDir,
          },
        },
      );
      throw new Error('media command unexpectedly succeeded');
    } catch (error: unknown) {
      const failed = error as { code?: number; stderr?: string };
      const stderr = failed.stderr ?? '';
      expect(failed.code).toBe(3);
      expect(stderr).toContain('failed to reach daemon');
      expect(stderr).not.toContain('OD_DATA_DIR');
    } finally {
      await chmod(dataDir, 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('routes od run logs to the requested run id when flags precede the positional id', async () => {
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
      requests.push(req.url ?? '');
      if (req.url?.startsWith('/api/runs/run-1/log')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          runId:     'run-1',
          nextSince: '1',
          events:    [{ id: 1, event: 'text', data: { kind: 'text', text: 'hello' }, timestamp: 1779148801000 }],
        }));
        return;
      }
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'run not found' } }));
    });

    try {
      const baseUrl = await listen(server);
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          '--import',
          'tsx',
          cliEntry,
          'run',
          'logs',
          '--daemon-url',
          baseUrl,
          '--since',
          '2026-05-19T00:00:00.000Z',
          'run-1',
          '--json',
        ],
        { cwd: daemonRoot },
      );

      expect(JSON.parse(stdout)).toMatchObject({
        runId:  'run-1',
        events: [{ id: 1, event: 'text' }],
      });
      expect(requests[0]).toBe('/api/runs/run-1/log?since=2026-05-19T00%3A00%3A00.000Z');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reports invalid run log cursors as input errors', async () => {
    const server = http.createServer((req, res) => {
      if (req.url?.startsWith('/api/runs/run-1/log')) {
        res.statusCode = 400;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'invalid since: expected an RFC3339 timestamp' } }));
        return;
      }
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'run not found' } }));
    });

    try {
      const baseUrl = await listen(server);
      await execFileAsync(
        process.execPath,
        [
          '--import',
          'tsx',
          cliEntry,
          'run',
          'logs',
          '--daemon-url',
          baseUrl,
          '--since',
          '2026-02-31T00:00:00Z',
          'run-1',
        ],
        { cwd: daemonRoot },
      );
      throw new Error('od run logs unexpectedly succeeded');
    } catch (error: unknown) {
      const failed = error as { code?: number; stderr?: string };
      expect(failed.code).toBe(2);
      expect(readStructuredError(failed.stderr ?? '')).toMatchObject({
        error: {
          code:    'invalid-input',
          message: 'invalid since: expected an RFC3339 timestamp',
        },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects unsupported od run logs flags instead of treating their values as the run id', async () => {
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
      requests.push(req.url ?? '');
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { code: 'UNEXPECTED', message: 'unexpected request' } }));
    });

    try {
      const baseUrl = await listen(server);
      await execFileAsync(
        process.execPath,
        [
          '--import',
          'tsx',
          cliEntry,
          'run',
          'logs',
          '--daemon-url',
          baseUrl,
          '--project',
          'project-1',
          'run-1',
        ],
        { cwd: daemonRoot },
      );
      throw new Error('od run logs unexpectedly succeeded');
    } catch (error: unknown) {
      const failed = error as { code?: number; stderr?: string };
      expect(failed.code).toBe(2);
      expect(failed.stderr).toContain('Unsupported od run logs flag: --project');
      expect(requests).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('passes event id cursors through to od run logs unchanged', async () => {
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
      requests.push(req.url ?? '');
      if (req.url?.startsWith('/api/runs/run-1/log')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          runId:     'run-1',
          nextSince: '3',
          events:    [
            { id: 2, event: 'text', data: { kind: 'text', text: 'hello' }, timestamp: 1779148800000 },
            { id: 3, event: 'end', data: { status: 'succeeded' }, timestamp: 1779148800000 },
          ],
        }));
        return;
      }
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'run not found' } }));
    });

    try {
      const baseUrl = await listen(server);
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          '--import',
          'tsx',
          cliEntry,
          'run',
          'logs',
          '--daemon-url',
          baseUrl,
          '--since',
          '1',
          'run-1',
        ],
        { cwd: daemonRoot },
      );

      expect(requests[0]).toBe('/api/runs/run-1/log?since=1');
      expect(stdout.trim().split('\n').map((line) => JSON.parse(line))).toEqual([
        expect.objectContaining({ id: 2, event: 'text', timestamp: 1779148800000 }),
        expect.objectContaining({ id: 3, event: 'end', timestamp: 1779148800000 }),
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');
  return `http://127.0.0.1:${address.port}`;
}

function readStructuredError(stderr: string) {
  const line = stderr.split('\n').find((entry) => entry.trim().startsWith('{'));
  if (!line) throw new Error(`missing structured error in stderr: ${stderr}`);
  return JSON.parse(line);
}
