import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  claimRoutineScheduledSlot,
  closeDatabase,
  insertRoutine,
  openDatabase,
} from '../src/db.js';

let tmp: string;
let dbFile: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'od-routine-claims-'));
  dbFile = path.join(tmp, 'app.sqlite');
});

afterEach(async () => {
  closeDatabase();
  await rm(tmp, { recursive: true, force: true });
});

describe('routine scheduled slot claims', () => {
  it('deduplicates scheduled slot reservations across SQLite connections', () => {
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

      expect(claimRoutineScheduledSlot(first, 'routine-1', 1779012900000)).toBe(true);
      expect(claimRoutineScheduledSlot(second, 'routine-1', 1779012900000)).toBe(false);
      expect(claimRoutineScheduledSlot(second, 'routine-1', 1779016500000)).toBe(true);
    } finally {
      second.close();
    }
  });
});
