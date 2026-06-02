import type http from 'node:http';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

const FIVE_MIB = 5 * 1024 * 1024;

describe('skills import/update request size limits', () => {
  let server: http.Server;
  let baseUrl: string;
  let userSkillsDir: string;
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
    const dataDir = process.env.OD_DATA_DIR;
    if (!dataDir) throw new Error('OD_DATA_DIR is required for daemon route tests');
    userSkillsDir = path.join(dataDir, 'skills');
    mkdirSync(userSkillsDir, { recursive: true });
  });

  afterAll(async () => {
    await Promise.resolve(shutdown?.());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function largeSideFilePayload(name: string) {
    return JSON.stringify({
      name,
      body: `# ${name}\n\nBody.`,
      files: [
        {
          path: 'assets/five-mib.bin',
          content: Buffer.alloc(FIVE_MIB, 0x7a).toString('base64'),
          encoding: 'base64',
        },
      ],
    });
  }

  it('accepts an advertised-limit side file over the import JSON transport', async () => {
    const res = await fetch(`${baseUrl}/api/skills/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: largeSideFilePayload('transport ceiling import'),
    });

    expect(res.status).toBe(201);
    const target = path.join(
      userSkillsDir,
      'transport-ceiling-import',
      'assets',
      'five-mib.bin',
    );
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target).byteLength).toBe(FIVE_MIB);
  });

  it('accepts an advertised-limit side file over the update JSON transport', async () => {
    const skillDir = path.join(userSkillsDir, 'transport-ceiling-update');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: transport ceiling update\ndescription: fixture\n---\n# Existing\n',
    );

    const res = await fetch(`${baseUrl}/api/skills/transport%20ceiling%20update`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: largeSideFilePayload('transport ceiling update'),
    });

    expect(res.status).toBe(200);
    const target = path.join(skillDir, 'assets', 'five-mib.bin');
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target).byteLength).toBe(FIVE_MIB);
  });
});
