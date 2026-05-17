import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  closeDatabase,
  getLatestRoutineRun,
  insertRoutine,
  insertRoutineRun,
  listRoutineRuns,
  openDatabase,
} from '../src/db.js';
import { classifyRoutineRunFailureReason } from '../src/routine-failure-reason.js';

describe('classifyRoutineRunFailureReason', () => {
  it('classifies agent authentication failures', () => {
    const reason = classifyRoutineRunFailureReason([
      {
        event: 'error',
        data: {
          message: 'Run claude /login before retrying.',
          error: {
            code: 'AGENT_AUTH_REQUIRED',
            message: 'Run claude /login before retrying.',
            retryable: true,
          },
        },
      },
    ]);

    expect(reason).toEqual({
      kind: 'agent_auth',
      message: 'Run claude /login before retrying.',
      code: 'AGENT_AUTH_REQUIRED',
      retryable: true,
    });
  });

  it('classifies agent spawn and CLI start failures', () => {
    const reason = classifyRoutineRunFailureReason([
      {
        event: 'error',
        data: {
          message: 'Agent "Codex" (`codex`) is not installed or not on PATH.',
          error: {
            code: 'AGENT_UNAVAILABLE',
            message: 'Agent "Codex" (`codex`) is not installed or not on PATH.',
            retryable: true,
          },
        },
      },
    ]);

    expect(reason).toEqual({
      kind: 'agent_spawn',
      message: 'Agent "Codex" (`codex`) is not installed or not on PATH.',
      code: 'AGENT_UNAVAILABLE',
      retryable: true,
    });
  });

  it('classifies inactivity watchdog timeouts', () => {
    const reason = classifyRoutineRunFailureReason([
      {
        event: 'error',
        data: {
          message: 'Agent stalled without emitting any new output for 1s. Phase details: spawned agent binary opencode.',
          error: {
            code: 'AGENT_EXECUTION_FAILED',
            message: 'Agent stalled without emitting any new output for 1s. Phase details: spawned agent binary opencode.',
            retryable: true,
          },
        },
      },
    ]);

    expect(reason).toEqual({
      kind: 'inactivity_watchdog',
      message: 'Agent stalled without emitting any new output for 1s. Phase details: spawned agent binary opencode.',
      code: 'AGENT_EXECUTION_FAILED',
      retryable: true,
    });
  });

  it('uses a generic fallback for unclassified failures', () => {
    const reason = classifyRoutineRunFailureReason([
      {
        event: 'error',
        data: {
          message: 'Agent exited with status 1.',
          error: {
            code: 'AGENT_EXECUTION_FAILED',
            message: 'Agent exited with status 1.',
            retryable: false,
          },
        },
      },
    ]);

    expect(reason).toEqual({
      kind: 'unknown',
      message: 'Agent exited with status 1.',
      code: 'AGENT_EXECUTION_FAILED',
      retryable: false,
    });
  });
});

describe('routine run failure reason persistence', () => {
  it('stores and reads structured failure reasons on routine run records', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-routine-failure-'));
    try {
      const db = openDatabase(tempDir, { dataDir: tempDir });
      const now = Date.now();
      insertRoutine(db, {
        id: 'routine-1',
        name: 'Daily digest',
        prompt: 'Summarize activity.',
        scheduleKind: 'daily',
        scheduleValue: '09:00',
        scheduleJson: JSON.stringify({ kind: 'daily', time: '09:00', timezone: 'UTC' }),
        projectMode: 'create_each_run',
        projectId: null,
        skillId: null,
        agentId: null,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
      const failureReason = {
        kind: 'inactivity_watchdog',
        message: 'Agent stalled without emitting any new output for 1s.',
        code: 'AGENT_EXECUTION_FAILED',
        retryable: true,
      } as const;
      insertRoutineRun(db, {
        id: 'run-1',
        routineId: 'routine-1',
        trigger: 'scheduled',
        status: 'failed',
        projectId: 'proj-1',
        conversationId: 'conv-1',
        agentRunId: 'agent-run-1',
        startedAt: now,
        completedAt: now + 1000,
        summary: null,
        error: failureReason.message,
        failureReason,
      });

      expect(getLatestRoutineRun(db, 'routine-1')?.failureReason).toEqual(failureReason);
      expect(listRoutineRuns(db, 'routine-1', 10)[0]?.failureReason).toEqual(failureReason);
    } finally {
      closeDatabase();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
