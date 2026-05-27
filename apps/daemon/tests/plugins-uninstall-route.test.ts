import type http from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PLUGIN_UNINSTALL_NOT_FOUND_CODE,
  PluginUninstallOutcomeSchema,
} from '@open-design/contracts';

import { startServer } from '../src/server.js';

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
});
