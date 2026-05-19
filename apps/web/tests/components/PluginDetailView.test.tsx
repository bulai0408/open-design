// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPluginRecord } from '@open-design/contracts';
import { PluginDetailView } from '../../src/components/PluginDetailView';

vi.mock('../../src/router', () => ({
  navigate: vi.fn(),
}));

function makePlugin(capabilitiesGranted: string[]): InstalledPluginRecord {
  return {
    id: 'sample-plugin',
    title: 'Sample Plugin',
    version: '1.0.0',
    sourceKind: 'local',
    source: '/tmp/sample',
    trust: 'restricted',
    capabilitiesGranted,
    manifest: {
      name: 'sample-plugin',
      version: '1.0.0',
      description: 'A restricted plugin fixture.',
      od: {
        kind: 'scenario',
        capabilities: ['prompt:inject', 'fs:read'],
      },
    },
    fsPath: '/tmp/sample',
    installedAt: 0,
    updatedAt: 0,
  };
}

function makeConnectorOnlyPlugin(capabilitiesGranted: string[]): InstalledPluginRecord {
  return {
    ...makePlugin(capabilitiesGranted),
    manifest: {
      name: 'sample-plugin',
      version: '1.0.0',
      description: 'A restricted connector plugin fixture.',
      od: {
        kind: 'scenario',
        connectors: {
          required: [{ id: 'slack', tools: ['channels.list'] }],
        },
      },
    },
  };
}

let currentPlugin: InstalledPluginRecord;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  currentPlugin = makePlugin(['prompt:inject']);
  fetchMock = vi.fn(async (url, init) => {
    if (url === '/api/plugins/sample-plugin' && !init) {
      return new Response(JSON.stringify(currentPlugin), { status: 200 });
    }
    if (url === '/api/plugins/sample-plugin/trust') {
      const body = JSON.parse(String(init?.body)) as {
        action: 'grant' | 'revoke';
        capabilities: string[];
      };
      if (body.action === 'grant') {
        currentPlugin = {
          ...currentPlugin,
          capabilitiesGranted: Array.from(new Set([
            ...currentPlugin.capabilitiesGranted,
            ...body.capabilities,
          ])).sort(),
        };
      } else {
        const drop = new Set(body.capabilities);
        currentPlugin = {
          ...currentPlugin,
          capabilitiesGranted: currentPlugin.capabilitiesGranted.filter((cap) => !drop.has(cap)),
        };
      }
      return new Response(JSON.stringify({
        ok: true,
        id: currentPlugin.id,
        action: body.action,
        capabilitiesGranted: currentPlugin.capabilitiesGranted,
        plugin: currentPlugin,
      }), { status: body.action === 'grant' ? 201 : 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('PluginDetailView trust controls', () => {
  it('grants a requested capability and refreshes the row state', async () => {
    render(<PluginDetailView pluginId="sample-plugin" />);

    const fsRead = await screen.findByLabelText('fs:read');
    expect(screen.getByTestId('plugin-capability-fs:read').textContent).toContain('Requested');

    fireEvent.click(fsRead);
    fireEvent.click(screen.getByRole('button', { name: 'Grant selected capabilities' }));

    await waitFor(() => {
      expect(screen.getByTestId('plugin-capability-fs:read').textContent).toContain('Granted');
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/plugins/sample-plugin/trust',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ capabilities: ['fs:read'], action: 'grant' }),
      }),
    );
  });

  it('revokes a granted capability and refreshes the row state', async () => {
    currentPlugin = makePlugin(['prompt:inject', 'fs:read']);

    render(<PluginDetailView pluginId="sample-plugin" />);

    const fsRead = await screen.findByLabelText('fs:read');
    expect(screen.getByTestId('plugin-capability-fs:read').textContent).toContain('Granted');

    fireEvent.click(fsRead);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke selected capabilities' }));

    await waitFor(() => {
      expect(screen.getByTestId('plugin-capability-fs:read').textContent).toContain('Requested');
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/plugins/sample-plugin/trust',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ capabilities: ['fs:read'], action: 'revoke' }),
      }),
    );
  });

  it('grants a capability derived from required connectors', async () => {
    currentPlugin = makeConnectorOnlyPlugin(['prompt:inject']);

    render(<PluginDetailView pluginId="sample-plugin" />);

    const slack = await screen.findByLabelText('connector:slack');
    expect(screen.getByTestId('plugin-capability-connector:slack').textContent).toContain('Requested');
    expect(screen.getByRole('button', { name: 'Grant selected capabilities' })).toHaveProperty('disabled', true);

    fireEvent.click(slack);
    fireEvent.click(screen.getByRole('button', { name: 'Grant selected capabilities' }));

    await waitFor(() => {
      expect(screen.getByTestId('plugin-capability-connector:slack').textContent).toContain('Granted');
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/plugins/sample-plugin/trust',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ capabilities: ['connector:slack'], action: 'grant' }),
      }),
    );
  });
});
