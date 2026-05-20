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

function makeRouteSwitchPlugin(): InstalledPluginRecord {
  return {
    ...makePlugin(['prompt:inject']),
    id: 'route-switch-plugin',
    title: 'Route Switch Plugin',
    source: '/tmp/route-switch',
    manifest: {
      name: 'route-switch-plugin',
      version: '1.0.0',
      description: 'A second restricted plugin fixture.',
      od: {
        kind: 'scenario',
        capabilities: ['prompt:inject', 'net:http'],
      },
    },
    fsPath: '/tmp/route-switch',
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

// Fixture matrix mirroring the daemon `requiredCapabilities()` derivation —
// each manifest declares a required capability only through an implied
// section (no duplicate entry in `od.capabilities`), so the checklist must
// derive a grantable row or the restricted plugin is stuck on the CLI path.
function makeMcpOnlyPlugin(capabilitiesGranted: string[]): InstalledPluginRecord {
  return {
    ...makePlugin(capabilitiesGranted),
    manifest: {
      name: 'sample-plugin',
      version: '1.0.0',
      description: 'A restricted MCP-context plugin fixture.',
      od: {
        kind: 'scenario',
        context: {
          mcp: [{ name: 'figma' }],
        },
      },
    },
  };
}

function makeGenuiComponentPlugin(capabilitiesGranted: string[]): InstalledPluginRecord {
  return {
    ...makePlugin(capabilitiesGranted),
    manifest: {
      name: 'sample-plugin',
      version: '1.0.0',
      description: 'A restricted GenUI custom-component plugin fixture.',
      od: {
        kind: 'scenario',
        genui: {
          surfaces: [
            {
              id: 'critique-panel',
              kind: 'form',
              persist: 'run',
              component: { path: './surfaces/critique-panel.tsx' },
            },
          ],
        },
        capabilities: ['genui:custom-component'],
      },
    },
  };
}

function makePipelinePlugin(capabilitiesGranted: string[]): InstalledPluginRecord {
  return {
    ...makePlugin(capabilitiesGranted),
    manifest: {
      name: 'sample-plugin',
      version: '1.0.0',
      description: 'A restricted pipeline plugin fixture.',
      od: {
        kind: 'scenario',
        pipeline: {
          stages: [{ id: 'draft', atoms: ['generate'] }],
        },
      },
    },
  };
}

let currentPlugin: InstalledPluginRecord;
let routeSwitchPlugin: InstalledPluginRecord;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  currentPlugin = makePlugin(['prompt:inject']);
  routeSwitchPlugin = makeRouteSwitchPlugin();
  fetchMock = vi.fn(async (url, init) => {
    if (url === '/api/plugins/sample-plugin' && !init) {
      return new Response(JSON.stringify(currentPlugin), { status: 200 });
    }
    if (url === '/api/plugins/route-switch-plugin' && !init) {
      return new Response(JSON.stringify(routeSwitchPlugin), { status: 200 });
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
    if (url === '/api/plugins/route-switch-plugin/trust') {
      const body = JSON.parse(String(init?.body)) as {
        action: 'grant' | 'revoke';
        capabilities: string[];
      };
      routeSwitchPlugin = {
        ...routeSwitchPlugin,
        capabilitiesGranted: Array.from(new Set([
          ...routeSwitchPlugin.capabilitiesGranted,
          ...body.capabilities,
        ])).sort(),
      };
      return new Response(JSON.stringify({
        ok: true,
        id: routeSwitchPlugin.id,
        action: body.action,
        capabilitiesGranted: routeSwitchPlugin.capabilitiesGranted,
        plugin: routeSwitchPlugin,
      }), { status: 201 });
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

  it('grants a capability derived from an MCP context server', async () => {
    currentPlugin = makeMcpOnlyPlugin(['prompt:inject']);

    render(<PluginDetailView pluginId="sample-plugin" />);

    const figma = await screen.findByLabelText('mcp:figma');
    expect(screen.getByTestId('plugin-capability-mcp:figma').textContent).toContain('Requested');

    fireEvent.click(figma);
    fireEvent.click(screen.getByRole('button', { name: 'Grant selected capabilities' }));

    await waitFor(() => {
      expect(screen.getByTestId('plugin-capability-mcp:figma').textContent).toContain('Granted');
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/plugins/sample-plugin/trust',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ capabilities: ['mcp:figma'], action: 'grant' }),
      }),
    );
  });

  it('derives a GenUI surface kind row and grants the custom-component capability', async () => {
    currentPlugin = makeGenuiComponentPlugin(['prompt:inject']);

    render(<PluginDetailView pluginId="sample-plugin" />);

    // The surface kind feeds `genui:<kind>` (mirroring the daemon resolver)
    // and the manifest-declared `genui:custom-component` is the grantable row.
    await screen.findByLabelText('genui:custom-component');
    expect(screen.getByTestId('plugin-capability-genui:form')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('genui:custom-component'));
    fireEvent.click(screen.getByRole('button', { name: 'Grant selected capabilities' }));

    await waitFor(() => {
      expect(
        screen.getByTestId('plugin-capability-genui:custom-component').textContent,
      ).toContain('Granted');
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/plugins/sample-plugin/trust',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ capabilities: ['genui:custom-component'], action: 'grant' }),
      }),
    );
  });

  it('derives and grants GenUI surface-kind and pipeline capabilities', async () => {
    currentPlugin = makePipelinePlugin(['prompt:inject']);

    render(<PluginDetailView pluginId="sample-plugin" />);

    const pipeline = await screen.findByLabelText('pipeline:*');
    expect(screen.getByTestId('plugin-capability-pipeline:*').textContent).toContain('Requested');

    fireEvent.click(pipeline);
    fireEvent.click(screen.getByRole('button', { name: 'Grant selected capabilities' }));

    await waitFor(() => {
      expect(screen.getByTestId('plugin-capability-pipeline:*').textContent).toContain('Granted');
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/plugins/sample-plugin/trust',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ capabilities: ['pipeline:*'], action: 'grant' }),
      }),
    );

    cleanup();
    currentPlugin = makeGenuiComponentPlugin(['prompt:inject']);
    render(<PluginDetailView pluginId="sample-plugin" />);

    const genuiForm = await screen.findByLabelText('genui:form');
    expect(screen.getByTestId('plugin-capability-genui:form').textContent).toContain('Requested');

    fireEvent.click(genuiForm);
    fireEvent.click(screen.getByRole('button', { name: 'Grant selected capabilities' }));

    await waitFor(() => {
      expect(screen.getByTestId('plugin-capability-genui:form').textContent).toContain('Granted');
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/plugins/sample-plugin/trust',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ capabilities: ['genui:form'], action: 'grant' }),
      }),
    );
  });

  it('does not carry pending trust selection across plugin detail route changes', async () => {
    const { rerender } = render(<PluginDetailView pluginId="sample-plugin" />);

    fireEvent.click(await screen.findByLabelText('fs:read'));
    expect(screen.getByText('1 grantable · 0 revokable')).toBeTruthy();

    rerender(<PluginDetailView pluginId="route-switch-plugin" />);

    const http = await screen.findByLabelText('net:http');
    await waitFor(() => {
      expect(screen.queryByText('1 grantable · 0 revokable')).toBeNull();
    });
    expect(screen.getByRole('button', { name: 'Grant selected capabilities' })).toHaveProperty('disabled', true);

    fireEvent.click(http);
    fireEvent.click(screen.getByRole('button', { name: 'Grant selected capabilities' }));

    await waitFor(() => {
      expect(screen.getByTestId('plugin-capability-net:http').textContent).toContain('Granted');
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/plugins/route-switch-plugin/trust',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ capabilities: ['net:http'], action: 'grant' }),
      }),
    );
  });
});
