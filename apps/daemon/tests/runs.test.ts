import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { createChatRunService } from '../src/runs.js';

describe('chat run service shutdown', () => {
  it('retains structured error details on failed run status bodies', async () => {
    const runs = createRuns();
    const run = runs.create({ projectId: 'project-1', conversationId: 'conv-1' });

    const wait = runs.wait(run);
    runs.emit(run, 'error', {
      message: 'Agent stalled without emitting any new output for 1s.',
      error: {
        code: 'AGENT_EXECUTION_FAILED',
        message: 'Agent stalled without emitting any new output for 1s.',
        retryable: true,
      },
    });
    runs.finish(run, 'failed', 1, null);

    expect(runs.statusBody(run)).toMatchObject({
      status: 'failed',
      errorCode: 'AGENT_EXECUTION_FAILED',
      error: 'Agent stalled without emitting any new output for 1s.',
    });
    await expect(wait).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'AGENT_EXECUTION_FAILED',
      error: 'Agent stalled without emitting any new output for 1s.',
    });
  });

  it('filters active runs by conversation within the same project', () => {
    const runs = createRuns();
    const runA = runs.create({ projectId: 'project-1', conversationId: 'conv-a' });
    const runB = runs.create({ projectId: 'project-1', conversationId: 'conv-b' });
    runA.status = 'running';
    runB.status = 'running';

    expect(
      runs.list({ projectId: 'project-1', conversationId: 'conv-b', status: 'active' }),
    ).toEqual([runB]);
  });

  it('returns historical event records filtered strictly after an RFC3339 cursor', () => {
    vi.useFakeTimers();
    try {
      const runs = createRuns();
      const run = runs.create({ projectId: 'project-1' });

      vi.setSystemTime(new Date('2026-05-19T00:00:00.000Z'));
      runs.emit(run, 'status', { kind: 'status', label: 'queued' });
      vi.setSystemTime(new Date('2026-05-19T00:00:02.000Z'));
      runs.emit(run, 'text', { kind: 'text', text: 'hello' });
      vi.setSystemTime(new Date('2026-05-19T00:00:03.000Z'));
      runs.finish(run, 'succeeded', 0, null);

      expect(runs.log(run, { since: '2026-05-19T00:00:02.000Z' })).toEqual([
        expect.objectContaining({
          id: 3,
          event: 'end',
          data: { code: 0, signal: null, status: 'succeeded' },
          timestamp: Date.parse('2026-05-19T00:00:03.000Z'),
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns same-millisecond event records filtered strictly after an event id cursor', () => {
    vi.useFakeTimers();
    try {
      const runs = createRuns();
      const run = runs.create({ projectId: 'project-1' });

      vi.setSystemTime(new Date('2026-05-19T00:00:00.000Z'));
      runs.emit(run, 'status', { kind: 'status', label: 'queued' });
      runs.emit(run, 'text', { kind: 'text', text: 'hello' });
      runs.finish(run, 'succeeded', 0, null);

      expect(runs.log(run, { since: '1' })).toEqual([
        expect.objectContaining({
          id: 2,
          event: 'text',
          timestamp: Date.parse('2026-05-19T00:00:00.000Z'),
        }),
        expect.objectContaining({
          id: 3,
          event: 'end',
          timestamp: Date.parse('2026-05-19T00:00:00.000Z'),
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects invalid historical event cursors', () => {
    const runs = createRuns();
    const run = runs.create();

    expect(() => runs.log(run, { since: 'not-a-date' })).toThrow(/invalid since/i);
    expect(() => runs.log(run, { since: '2026-02-31T00:00:00Z' })).toThrow(/invalid since/i);
    expect(() => runs.log(run, { since: '' })).toThrow(/invalid since/i);
  });

  it('stores effective media execution policy on run status bodies', () => {
    const runs = createRuns();
    const defaultRun = runs.create({ projectId: 'project-1', conversationId: 'conv-a' });
    const scopedRun = runs.create({
      projectId: 'project-1',
      conversationId: 'conv-b',
      mediaExecution: { mode: 'enabled', allowedSurfaces: ['image'] },
    });

    expect(runs.statusBody(defaultRun)).toMatchObject({
      mediaExecution: { mode: 'enabled' },
    });
    expect(runs.statusBody(scopedRun)).toMatchObject({
      mediaExecution: { mode: 'enabled', allowedSurfaces: ['image'] },
    });
  });

  it('cancels active runs and terminates their child process during daemon shutdown', async () => {
    const runs = createRuns();
    const child = new FakeChildProcess({ closeOn: 'SIGTERM' });
    const run = runs.create({ projectId: 'project-1', conversationId: 'conv-1' });
    run.status = 'running';
    (run as any).child = child;

    const wait = runs.wait(run);
    await runs.shutdownActive({ graceMs: 10 });

    expect(child.signals).toEqual(['SIGTERM']);
    expect(run.status).toBe('canceled');
    expect(run.cancelRequested).toBe(true);
    expect(run.signal).toBe('SIGTERM');
    await expect(wait).resolves.toMatchObject({ status: 'canceled', signal: 'SIGTERM' });
    expect(run.events.at(-1)).toMatchObject({
      event: 'end',
      data: { status: 'canceled', signal: 'SIGTERM' },
    });
  });

  it('escalates to SIGKILL when a child ignores the shutdown SIGTERM grace window', async () => {
    const runs = createRuns();
    const child = new FakeChildProcess({ closeOn: 'SIGKILL' });
    const run = runs.create();
    run.status = 'running';
    (run as any).child = child;

    await runs.shutdownActive({ graceMs: 1 });

    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(run.status).toBe('canceled');
  });

  it('uses adapter abort before process signals for ACP-style runs', async () => {
    const runs = createRuns();
    const child = new FakeChildProcess({ closeOn: 'SIGTERM' });
    const abort = vi.fn();
    const run = runs.create();
    run.status = 'running';
    (run as any).child = child;
    (run as any).acpSession = { abort };

    await runs.shutdownActive({ graceMs: 10 });

    expect(abort).toHaveBeenCalledTimes(1);
    expect(child.signals).toEqual(['SIGTERM']);
    expect(run.status).toBe('canceled');
  });
});

describe('chat run service stream replay', () => {
  it('always replays the final event when a reattaching client cursor is at the end of a terminal run', () => {
    const sendCalls: Array<{ event: string; data: unknown; id: number }> = [];
    const endCalls: number[] = [];
    const runs = createChatRunService({
      createSseResponse: () => ({
        send: vi.fn((event: string, data: unknown, id: number) => {
          sendCalls.push({ event, data, id });
          return true;
        }),
        end: vi.fn(() => endCalls.push(1)),
        cleanup: vi.fn(),
      }),
      createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }),
      shutdownGraceMs: 10,
      ttlMs: 60_000,
    });

    const run = runs.create({ projectId: 'p', conversationId: 'c' }) as any;
    runs.emit(run, 'stdout', { text: 'hello' });
    runs.finish(run, 'succeeded', 0, null);

    const finalEventId = run.events.at(-1).id;
    const fakeReq = {
      get: () => null,
      query: { after: String(finalEventId) },
    } as never;
    const fakeRes = { on: () => {} } as never;

    sendCalls.length = 0;
    runs.stream(run, fakeReq, fakeRes);

    expect(sendCalls.length).toBeGreaterThanOrEqual(1);
    expect(sendCalls.at(-1)?.event).toBe('end');
    expect(endCalls.length).toBe(1);
  });

  it('does not duplicate events when the cursor sits before the final event', () => {
    const sendCalls: Array<{ event: string; data: unknown; id: number }> = [];
    const runs = createChatRunService({
      createSseResponse: () => ({
        send: vi.fn((event: string, data: unknown, id: number) => {
          sendCalls.push({ event, data, id });
          return true;
        }),
        end: vi.fn(),
        cleanup: vi.fn(),
      }),
      createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }),
      shutdownGraceMs: 10,
      ttlMs: 60_000,
    });

    const run = runs.create() as any;
    runs.emit(run, 'stdout', { text: 'a' });
    runs.emit(run, 'stdout', { text: 'b' });
    runs.finish(run, 'succeeded', 0, null);

    const cursor = run.events[0].id;
    runs.stream(
      run,
      { get: () => null, query: { after: String(cursor) } } as never,
      { on: () => {} } as never,
    );

    expect(sendCalls.map((c) => c.id)).toEqual(
      run.events.filter((e: { id: number }) => e.id > cursor).map((e: { id: number }) => e.id),
    );
  });
});

function createRuns() {
  return createChatRunService({
    createSseResponse: () => ({
      send: vi.fn(() => true),
      end: vi.fn(),
      cleanup: vi.fn(),
    }),
    createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }),
    shutdownGraceMs: 10,
    ttlMs: 60_000,
  });
}

class FakeChildProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  signals: string[] = [];

  constructor(private readonly options: { closeOn: 'SIGTERM' | 'SIGKILL' }) {
    super();
  }

  kill(signal: string): boolean {
    this.killed = true;
    this.signals.push(signal);
    if (signal === this.options.closeOn) {
      this.signalCode = signal;
      queueMicrotask(() => {
        this.emit('exit', null, signal);
        this.emit('close', null, signal);
      });
    }
    return true;
  }
}
