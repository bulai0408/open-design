// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPluginRecord } from '@open-design/contracts';

import { PluginsView } from '../../src/components/PluginsView';
import { I18nProvider } from '../../src/i18n';

function makePlugin(id: string, title: string): InstalledPluginRecord {
  return {
    id,
    title,
    version: '1.0.0',
    sourceKind: 'user',
    source: `/tmp/${id}`,
    trust: 'trusted',
    capabilitiesGranted: ['prompt:inject'],
    fsPath: `/tmp/${id}`,
    installedAt: 0,
    updatedAt: 0,
    manifest: {
      name: id,
      title,
      version: '1.0.0',
      description: `${title} fixture`,
      tags: ['fixture'],
      od: {
        kind: 'scenario',
        taskKind: 'new-generation',
        useCase: {
          query: `Hydrated query from ${title}`,
        },
      },
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PluginsView uninstall', () => {
  it('uses localized plugin titles and strings in the uninstall flow', async () => {
    const plugin = makePlugin('localized-plugin', 'Raw English Plugin');
    plugin.manifest.title_i18n = {
      en: 'Raw English Plugin',
      'zh-CN': '本地化插件',
    };
    let uninstalled = false;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = input.toString();

      if (url === '/api/plugins' && (!init || init.method === undefined)) {
        return new Response(JSON.stringify({ plugins: uninstalled ? [] : [plugin] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url === '/api/plugins/localized-plugin/uninstall' && init?.method === 'POST') {
        uninstalled = true;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url === '/api/marketplaces' && (!init || init.method === undefined)) {
        return new Response(JSON.stringify({ marketplaces: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('IntersectionObserver', class {
      observe() {}
      disconnect() {}
      unobserve() {}
    });

    render(
      <I18nProvider initial="zh-CN">
        <PluginsView />
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByRole('button', {
      name: '卸载 本地化插件',
    }));

    const dialog = await screen.findByRole('dialog', {
      name: '卸载 本地化插件',
    });
    expect(dialog.textContent).toContain('卸载 本地化插件');
    expect(dialog.textContent).not.toContain('Raw English Plugin');

    fireEvent.click(screen.getByRole('button', { name: '卸载插件' }));

    await waitFor(() => {
      expect(screen.queryByText('本地化插件')).toBeNull();
    });
    expect(screen.getByText('已卸载 本地化插件。')).toBeTruthy();
    expect(screen.queryByText('Uninstalled Raw English Plugin.')).toBeNull();
  });

  it('confirms before uninstalling an installed user plugin and refreshes the list', async () => {
    const plugin = makePlugin('fixture-plugin', 'Fixture Plugin');
    let uninstalled = false;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = input.toString();

      if (url === '/api/plugins' && (!init || init.method === undefined)) {
        return new Response(JSON.stringify({ plugins: uninstalled ? [] : [plugin] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url === '/api/plugins/fixture-plugin/uninstall' && init?.method === 'POST') {
        uninstalled = true;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url === '/api/marketplaces' && (!init || init.method === undefined)) {
        return new Response(JSON.stringify({ marketplaces: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('IntersectionObserver', class {
      observe() {}
      disconnect() {}
      unobserve() {}
    });

    render(<PluginsView />);

    const uninstallButton = await screen.findByRole('button', {
      name: 'Uninstall Fixture Plugin',
    });

    fireEvent.click(uninstallButton);

    const dialog = await screen.findByRole('dialog', {
      name: 'Uninstall Fixture Plugin',
    });
    expect(dialog.textContent).toContain('Fixture Plugin');

    fireEvent.click(screen.getByRole('button', { name: 'Uninstall plugin' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/plugins/fixture-plugin/uninstall',
        { method: 'POST' },
      );
    });
    const uninstallCallIndex = fetchMock.mock.calls.findIndex(([input, init]) => (
      input.toString() === '/api/plugins/fixture-plugin/uninstall' && init?.method === 'POST'
    ));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input, init], index) => (
        index > uninstallCallIndex
        && input.toString() === '/api/marketplaces'
        && (!init || init.method === undefined)
      ))).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByText('Fixture Plugin')).toBeNull();
    });
    expect(screen.getByText('Uninstalled Fixture Plugin.')).toBeTruthy();
  });

  it('surfaces daemon cleanup warnings after a partial uninstall', async () => {
    const plugin = makePlugin('fixture-plugin', 'Fixture Plugin');
    let uninstalled = false;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = input.toString();

      if (url === '/api/plugins' && (!init || init.method === undefined)) {
        return new Response(JSON.stringify({ plugins: uninstalled ? [] : [plugin] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url === '/api/plugins/fixture-plugin/uninstall' && init?.method === 'POST') {
        uninstalled = true;
        return new Response(
          JSON.stringify({
            ok: true,
            warning: 'Folder /tmp/fixture-plugin removal failed: permission denied',
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }

      if (url === '/api/marketplaces' && (!init || init.method === undefined)) {
        return new Response(JSON.stringify({ marketplaces: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('IntersectionObserver', class {
      observe() {}
      disconnect() {}
      unobserve() {}
    });

    render(<PluginsView />);

    fireEvent.click(await screen.findByRole('button', {
      name: 'Uninstall Fixture Plugin',
    }));
    fireEvent.click(await screen.findByRole('button', { name: 'Uninstall plugin' }));

    await waitFor(() => {
      expect(screen.queryByText('Fixture Plugin')).toBeNull();
    });
    expect(
      screen.getByText('Uninstalled Fixture Plugin, but cleanup was incomplete.'),
    ).toBeTruthy();
    expect(
      screen.getByText('Folder /tmp/fixture-plugin removal failed: permission denied'),
    ).toBeTruthy();
    expect(screen.queryByText('Uninstalled Fixture Plugin.')).toBeNull();
  });

  it('refreshes installed plugins when uninstall reports the plugin is already missing', async () => {
    const plugin = makePlugin('fixture-plugin', 'Fixture Plugin');
    let missing = false;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = input.toString();

      if (url === '/api/plugins' && (!init || init.method === undefined)) {
        return new Response(JSON.stringify({ plugins: missing ? [] : [plugin] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url === '/api/plugins/fixture-plugin/uninstall' && init?.method === 'POST') {
        missing = true;
        return new Response(
          JSON.stringify({
            error: 'plugin not found',
            warning: 'Registry row was already missing',
          }),
          {
            status: 404,
            headers: { 'content-type': 'application/json' },
            statusText: 'Not Found',
          },
        );
      }

      if (url === '/api/marketplaces' && (!init || init.method === undefined)) {
        return new Response(JSON.stringify({ marketplaces: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('IntersectionObserver', class {
      observe() {}
      disconnect() {}
      unobserve() {}
    });

    render(<PluginsView />);

    fireEvent.click(await screen.findByRole('button', {
      name: 'Uninstall Fixture Plugin',
    }));
    fireEvent.click(await screen.findByRole('button', { name: 'Uninstall plugin' }));

    const uninstallCallIndex = await waitFor(() => {
      const index = fetchMock.mock.calls.findIndex(([input, init]) => (
        input.toString() === '/api/plugins/fixture-plugin/uninstall' && init?.method === 'POST'
      ));
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    });
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input, init], index) => (
        index > uninstallCallIndex
        && input.toString() === '/api/marketplaces'
        && (!init || init.method === undefined)
      ))).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByText('Fixture Plugin')).toBeNull();
    });
    expect(screen.getByText('Fixture Plugin is no longer installed.')).toBeTruthy();
    expect(screen.getByText('Registry row was already missing')).toBeTruthy();
    expect(screen.queryByText('Make sure the daemon is reachable.')).toBeNull();
  });

  it('treats unrelated uninstall 404 responses as failures', async () => {
    const plugin = makePlugin('fixture-plugin', 'Fixture Plugin');
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = input.toString();

      if (url === '/api/plugins' && (!init || init.method === undefined)) {
        return new Response(JSON.stringify({ plugins: [plugin] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url === '/api/plugins/fixture-plugin/uninstall' && init?.method === 'POST') {
        return new Response(JSON.stringify({ error: 'route not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
          statusText: 'Not Found',
        });
      }

      if (url === '/api/marketplaces' && (!init || init.method === undefined)) {
        return new Response(JSON.stringify({ marketplaces: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('IntersectionObserver', class {
      observe() {}
      disconnect() {}
      unobserve() {}
    });

    render(<PluginsView />);

    fireEvent.click(await screen.findByRole('button', {
      name: 'Uninstall Fixture Plugin',
    }));
    fireEvent.click(await screen.findByRole('button', { name: 'Uninstall plugin' }));

    expect(await screen.findByText('Failed to uninstall Fixture Plugin. route not found')).toBeTruthy();
    expect(screen.queryByText('Fixture Plugin is no longer installed.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Uninstall Fixture Plugin' })).toBeTruthy();
  });

  it('shows daemon error bodies when uninstall fails', async () => {
    const plugin = makePlugin('fixture-plugin', 'Fixture Plugin');
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = input.toString();

      if (url === '/api/plugins' && (!init || init.method === undefined)) {
        return new Response(JSON.stringify({ plugins: [plugin] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url === '/api/plugins/fixture-plugin/uninstall' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            error: 'cleanup failed',
            warning: 'Folder /tmp/fixture-plugin removal failed: permission denied',
          }),
          {
            status: 500,
            headers: { 'content-type': 'application/json' },
            statusText: 'Internal Server Error',
          },
        );
      }

      if (url === '/api/marketplaces' && (!init || init.method === undefined)) {
        return new Response(JSON.stringify({ marketplaces: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('IntersectionObserver', class {
      observe() {}
      disconnect() {}
      unobserve() {}
    });

    render(<PluginsView />);

    fireEvent.click(await screen.findByRole('button', {
      name: 'Uninstall Fixture Plugin',
    }));
    fireEvent.click(await screen.findByRole('button', { name: 'Uninstall plugin' }));

    expect(await screen.findByText('Failed to uninstall Fixture Plugin. cleanup failed')).toBeTruthy();
    expect(
      screen.getByText('Folder /tmp/fixture-plugin removal failed: permission denied'),
    ).toBeTruthy();
    expect(screen.queryByText('Make sure the daemon is reachable.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Uninstall Fixture Plugin' })).toBeTruthy();
  });
});
