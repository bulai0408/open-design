// @vitest-environment jsdom

// Covers the mid-chat design-system switcher (issue #498 v1). The
// composer's import menu hosts a "Skills and design systems" entry that
// expands inline into a picker; selecting a system PATCHes the project
// and emits a toast through the parent. These tests pin the entry-point
// affordance, the PATCH payload, and the toast/parent-callback contract
// so a regression on any of the three turns the picker silently
// useless.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatComposer } from '../../src/components/ChatComposer';
import { fetchDesignSystems } from '../../src/providers/registry';

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    fetchDesignSystems: vi.fn(),
  };
});

const mockedFetchDesignSystems = vi.mocked(fetchDesignSystems);

const FAKE_DESIGN_SYSTEMS = [
  {
    id: 'nexu-soft-tech',
    title: 'Nexu Soft Tech',
    category: 'Product',
    summary: 'Warm utility system for product interfaces.',
    swatches: ['#F7F4EE', '#1F2937'],
  },
  {
    id: 'editorial-mono',
    title: 'Editorial Mono',
    category: 'Editorial',
    summary: 'Magazine-style typographic system.',
    swatches: [],
  },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

async function openImportTab(): Promise<void> {
  const trigger = await screen.findByLabelText(/Open CLI and model settings/i);
  fireEvent.click(trigger);
  // The composer auto-snaps to the first available tab; when no MCP
  // wiring is passed in tests, that is the Import tab — but the tab strip
  // also renders an Import tab button. Click it defensively in case the
  // default lands elsewhere.
  const importTab = screen.queryByRole('tab', { name: /import/i });
  if (importTab) fireEvent.click(importTab);
}

describe('ChatComposer mid-chat design-system switcher', () => {
  it('opens the design-system picker from the Import menu and PATCHes the project on select', async () => {
    mockedFetchDesignSystems.mockResolvedValue(FAKE_DESIGN_SYSTEMS);
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL | Request).toString();
      if (url.startsWith('/api/projects/')) {
        return new Response(
          JSON.stringify({
            project: {
              id: 'project-1',
              name: 'p',
              skillId: null,
              designSystemId: 'nexu-soft-tech',
              createdAt: 1,
              updatedAt: 2,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200 });
    });

    const onActiveDesignSystemChange = vi.fn();
    const onShowToast = vi.fn();

    render(
      <ChatComposer
        projectId="project-1"
        projectFiles={[]}
        streaming={false}
        onEnsureProject={async () => 'project-1'}
        onSend={vi.fn()}
        onStop={vi.fn()}
        currentDesignSystemId={null}
        onActiveDesignSystemChange={onActiveDesignSystemChange}
        onShowToast={onShowToast}
      />,
    );

    await openImportTab();

    const dsEntry = await screen.findByTestId('composer-import-design-systems');
    fireEvent.click(dsEntry);

    // Picker mounts and asks for the list.
    await waitFor(() => expect(mockedFetchDesignSystems).toHaveBeenCalled());
    expect(screen.getByTestId('composer-ds-picker')).toBeTruthy();

    const item = await screen.findByTestId('composer-ds-picker-item-nexu-soft-tech');
    fireEvent.click(item);

    await waitFor(() => {
      const patchCall = fetchSpy.mock.calls.find(([u]) => String(u) === '/api/projects/project-1');
      expect(patchCall).toBeTruthy();
    });
    const patchCall = fetchSpy.mock.calls.find(([u]) => String(u) === '/api/projects/project-1')!;
    expect((patchCall[1] as RequestInit | undefined)?.method).toBe('PATCH');
    expect(JSON.parse(String((patchCall[1] as RequestInit).body))).toEqual({
      designSystemId: 'nexu-soft-tech',
    });

    await waitFor(() => expect(onActiveDesignSystemChange).toHaveBeenCalledWith('nexu-soft-tech'));
    expect(onShowToast).toHaveBeenCalledWith(
      'Design system switched to Nexu Soft Tech',
    );
  });

  it('emits a failure toast and keeps the picker open when the PATCH fails', async () => {
    mockedFetchDesignSystems.mockResolvedValue(FAKE_DESIGN_SYSTEMS);
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL | Request).toString();
      if (url.startsWith('/api/projects/')) {
        return new Response('{}', { status: 500 });
      }
      return new Response('{}', { status: 200 });
    });

    const onActiveDesignSystemChange = vi.fn();
    const onShowToast = vi.fn();

    render(
      <ChatComposer
        projectId="project-1"
        projectFiles={[]}
        streaming={false}
        onEnsureProject={async () => 'project-1'}
        onSend={vi.fn()}
        onStop={vi.fn()}
        currentDesignSystemId={null}
        onActiveDesignSystemChange={onActiveDesignSystemChange}
        onShowToast={onShowToast}
      />,
    );

    await openImportTab();
    fireEvent.click(await screen.findByTestId('composer-import-design-systems'));
    fireEvent.click(await screen.findByTestId('composer-ds-picker-item-nexu-soft-tech'));

    await waitFor(() =>
      expect(onShowToast).toHaveBeenCalledWith(
        "Couldn't switch design system. Please try again.",
      ),
    );
    expect(onActiveDesignSystemChange).not.toHaveBeenCalled();
    // Picker remains visible so the user can retry without re-opening
    // the import menu.
    expect(screen.getByTestId('composer-ds-picker')).toBeTruthy();
  });

  it('keeps the design-system row disabled when no project is active', async () => {
    mockedFetchDesignSystems.mockResolvedValue(FAKE_DESIGN_SYSTEMS);
    render(
      <ChatComposer
        projectId={null}
        projectFiles={[]}
        streaming={false}
        onEnsureProject={async () => null}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    await openImportTab();
    const entry = await screen.findByTestId('composer-import-design-systems');
    expect((entry as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(entry);
    expect(screen.queryByTestId('composer-ds-picker')).toBeNull();
  });

  it("doesn't PATCH when the user picks the current design system", async () => {
    mockedFetchDesignSystems.mockResolvedValue(FAKE_DESIGN_SYSTEMS);
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => {
      return new Response('{}', { status: 200 });
    });
    const onShowToast = vi.fn();

    render(
      <ChatComposer
        projectId="project-1"
        projectFiles={[]}
        streaming={false}
        onEnsureProject={async () => 'project-1'}
        onSend={vi.fn()}
        onStop={vi.fn()}
        currentDesignSystemId="nexu-soft-tech"
        onShowToast={onShowToast}
      />,
    );

    await openImportTab();
    fireEvent.click(await screen.findByTestId('composer-import-design-systems'));
    const item = await screen.findByTestId('composer-ds-picker-item-nexu-soft-tech');
    // The current row is rendered disabled, but defensively assert that
    // a synthetic click does not turn into a PATCH either.
    expect((item as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(item);
    await act(async () => {
      await Promise.resolve();
    });
    const patchCalls = fetchSpy.mock.calls.filter(([u]) =>
      String(u).startsWith('/api/projects/'),
    );
    expect(patchCalls).toHaveLength(0);
    expect(onShowToast).not.toHaveBeenCalled();
  });
});

// Surfaces unused helper for ergonomics — `deferred` is kept exported via
// the closing void to avoid TS6133 if a future test re-introduces it.
void deferred;
