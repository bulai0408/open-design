import type http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import Database from 'better-sqlite3';
import type { InstalledPluginRecord, PluginManifest } from '@open-design/contracts';

import {
  closeDatabase,
  getProject,
  insertRoutine,
  insertRoutineRun,
  insertScheduledRoutineRun,
  insertProject,
  openDatabase,
} from '../src/db.js';
import { startServer } from '../src/server.js';
import { upsertInstalledPlugin } from '../src/plugins/registry.js';
import { createSnapshot, linkSnapshotToProject } from '../src/plugins/snapshots.js';

let tmp: string;
let dbFile: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'od-routine-claims-'));
  dbFile = path.join(tmp, 'app.sqlite');
});

afterEach(async () => {
  vi.useRealTimers();
  closeDatabase();
  await rm(tmp, { recursive: true, force: true });
});

describe('routine scheduled slot claims', () => {
  it('deduplicates scheduled run insertion in the same transaction as the slot claim', () => {
    const first = openDatabase(tmp, { dataDir: tmp });
    insertRoutine(first, {
      id: 'routine-1',
      name: 'Daily brief',
      prompt: 'Summarize the day',
      scheduleKind: 'hourly',
      scheduleValue: '15',
      scheduleJson: JSON.stringify({ kind: 'hourly', minute: 15 }),
      projectMode: 'create_each_run',
      projectId: null,
      skillId: null,
      agentId: null,
      enabled: true,
      createdAt: 1779012000000,
      updatedAt: 1779012000000,
    });

    const second = new Database(dbFile);
    try {
      second.pragma('foreign_keys = ON');

      const firstRun = insertScheduledRoutineRun(first, makeRun('run-1'), 1779012900000);
      const secondRun = insertScheduledRoutineRun(second, makeRun('run-2'), 1779012900000);
      const manualRun = insertRoutineRun(second, makeRun('run-manual', { trigger: 'manual' }));

      expect(firstRun?.id).toBe('run-1');
      expect(secondRun).toBeNull();
      expect(manualRun?.id).toBe('run-manual');
      expect(
        first.prepare(`SELECT id FROM routine_runs ORDER BY id`).all(),
      ).toEqual([{ id: 'run-1' }, { id: 'run-manual' }]);
    } finally {
      second.close();
    }
  });
});

function makeRun(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    routineId: 'routine-1',
    trigger: 'scheduled',
    status: 'running',
    projectId: `project-${id}`,
    conversationId: `conversation-${id}`,
    agentRunId: `agent-${id}`,
    startedAt: 1779012900000,
    completedAt: null,
    summary: null,
    error: null,
    ...overrides,
  };
}

describe('routine scheduled loser cleanup', () => {
  it('does not let a discarded reuse-mode loser replace the shared project snapshot pin', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-17T10:00:00.000Z'));

    const started = await startServer({ port: 0, returnServer: true }) as {
      url: string;
      server: http.Server;
      shutdown?: () => Promise<void> | void;
    };
    const dataDir = process.env.OD_DATA_DIR;
    if (!dataDir) throw new Error('OD_DATA_DIR is required for daemon route tests');
    const db = openDatabase(tmp, { dataDir });
    const projectId = 'routine-reuse-project';
    const routinePlugin = pluginRecord('routine-plugin');
    upsertInstalledPlugin(db, routinePlugin);
    insertProject(db, {
      id: projectId,
      name: 'Routine reuse target',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const previousSnapshot = createSnapshot(db, {
      projectId,
      pluginId: routinePlugin.id,
      pluginVersion: routinePlugin.version,
      manifestSourceDigest: '0'.repeat(64),
      taskKind: 'new-generation',
      inputs: { prompt: 'previous prompt' },
      resolvedContext: { items: [] },
      capabilitiesGranted: ['prompt:inject'],
      capabilitiesRequired: ['prompt:inject'],
      assetsStaged: [],
      connectorsRequired: [],
      connectorsResolved: [],
      mcpServers: [],
      query: 'Previous {{prompt}}',
    });
    linkSnapshotToProject(db, previousSnapshot.snapshotId, projectId);

    try {
      const createRoutine = await fetch(`${started.url}/api/routines`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Scheduled reuse routine',
          prompt: 'fresh prompt',
          schedule: { kind: 'hourly', minute: 1 },
          target: { mode: 'reuse', projectId },
          context: { pluginIds: [routinePlugin.id] },
          agentId: 'codex',
          enabled: true,
        }),
      });
      expect(createRoutine.status).toBe(201);
      const created = await createRoutine.json() as { routine: { id: string } };
      const slotAt = Date.UTC(2026, 4, 17, 10, 1);
      insertScheduledRoutineRun(db, {
        ...makeRun('winning-run', {
          routineId: created.routine.id,
          projectId,
          conversationId: 'winning-conversation',
          agentRunId: 'winning-agent-run',
        }),
      }, slotAt);

      await vi.advanceTimersByTimeAsync(60_000);
      vi.useRealTimers();
      let snapshotCount = 0;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        await sleep(10);
        snapshotCount = (db.prepare(
          `SELECT COUNT(*) AS n FROM applied_plugin_snapshots WHERE project_id = ?`,
        ).get(projectId) as { n: number }).n;
        if (snapshotCount > 1) break;
      }

      expect(snapshotCount).toBeGreaterThan(1);
      expect(getProject(db, projectId)?.appliedPluginSnapshotId)
        .toBe(previousSnapshot.snapshotId);
      const loserSnapshot = db.prepare(
        `SELECT run_id AS runId, expires_at AS expiresAt
           FROM applied_plugin_snapshots
          WHERE project_id = ?
            AND id <> ?`,
      ).get(projectId, previousSnapshot.snapshotId) as {
        runId: string | null;
        expiresAt: number | null;
      };
      expect(loserSnapshot.runId).toBeNull();
      expect(loserSnapshot.expiresAt).not.toBeNull();
    } finally {
      await Promise.resolve(started.shutdown?.());
      await new Promise<void>((resolve) => started.server.close(() => resolve()));
    }
  });
});

function pluginRecord(id: string): InstalledPluginRecord {
  const manifest: PluginManifest = {
    name: id,
    title: 'Routine Plugin',
    version: '1.0.0',
    description: 'Routine snapshot fixture.',
    od: {
      kind: 'skill',
      taskKind: 'new-generation',
      useCase: { query: 'Handle {{prompt}}' },
      inputs: [{ name: 'prompt', type: 'string', required: true }],
      capabilities: ['prompt:inject'],
    },
  } as PluginManifest;
  return {
    id,
    title: 'Routine Plugin',
    version: '1.0.0',
    sourceKind: 'local',
    source: `/tmp/${id}`,
    fsPath: `/tmp/${id}`,
    trust: 'trusted',
    capabilitiesGranted: ['prompt:inject'],
    installedAt: Date.now(),
    updatedAt: Date.now(),
    manifest,
  };
}
