import type http from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

describe('GET /api/runs/:id/log', () => {
  let server: http.Server;
  let baseUrl: string;
  let shutdown: (() => Promise<void> | void) | undefined;
  const originalPath = process.env.PATH;

  beforeAll(async () => {
    const started = await startServer({ port: 0, returnServer: true }) as {
      url: string;
      server: http.Server;
      shutdown?: () => Promise<void> | void;
    };
    baseUrl = started.url;
    server = started.server;
    shutdown = started.shutdown;
  });

  afterEach(() => {
    if (originalPath == null) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  });

  afterAll(async () => {
    await Promise.resolve(shutdown?.());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns buffered run events and filters strictly after an RFC3339 timestamp', async () => {
    process.env.PATH = '';
    const createResponse = await fetch(`${baseUrl}/api/runs`, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ agentId: 'opencode', message: 'hello' }),
    });
    expect(createResponse.status).toBe(202);
    const { runId } = await createResponse.json() as { runId: string };
    await waitForRunStatus(baseUrl, runId);

    const logsResponse = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(runId)}/log`);
    expect(logsResponse.status).toBe(200);
    const logs = await logsResponse.json() as {
      runId: string;
      events: Array<{ id: number; event: string; timestamp: number }>;
    };
    expect(logs.runId).toBe(runId);
    expect(logs.events.some((event) => event.event === 'error')).toBe(true);
    expect(logs.events.at(-1)?.event).toBe('end');

    const newestTimestamp = Math.max(...logs.events.map((event) => event.timestamp));
    const filteredResponse = await fetch(
      `${baseUrl}/api/runs/${encodeURIComponent(runId)}/log?since=${encodeURIComponent(new Date(newestTimestamp).toISOString())}`,
    );
    expect(filteredResponse.status).toBe(200);
    const filtered = await filteredResponse.json() as { events: unknown[] };
    expect(filtered.events).toEqual([]);
  });

  it('rejects invalid since timestamps', async () => {
    process.env.PATH = '';
    const createResponse = await fetch(`${baseUrl}/api/runs`, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ agentId: 'opencode', message: 'hello' }),
    });
    expect(createResponse.status).toBe(202);
    const { runId } = await createResponse.json() as { runId: string };

    const response = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(runId)}/log?since=not-a-date`);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'BAD_REQUEST' },
    });
  });
});

async function waitForRunStatus(baseUrl: string, runId: string): Promise<{ status: string }> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const statusResponse = await fetch(`${baseUrl}/api/runs/${runId}`);
    const statusBody = await statusResponse.json() as { status: string };
    if (statusBody.status !== 'queued' && statusBody.status !== 'running') return statusBody;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('run did not reach expected status');
}
