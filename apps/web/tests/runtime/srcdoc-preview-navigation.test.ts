import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

import { buildSrcdoc } from '../../src/runtime/srcdoc';

function extractBridgeScript(html: string): string {
  const match = html.match(
    /<script\s+data-od-preview-navigation-restore>([\s\S]*?)<\/script>/,
  );
  if (!match || match[1] == null) {
    throw new Error('preview-navigation-restore script not found');
  }
  return match[1];
}

interface BridgeHarness {
  parentMessages: Array<Record<string, unknown>>;
  triggerEvent: (type: string, ev?: { data?: unknown }) => void;
  state: { href: string; hash: string; pathname: string; search: string; state: unknown };
}

function runBridge(html: string, opts?: {
  initialPathname?: string;
  initialSearch?: string;
  initialHash?: string;
}): BridgeHarness {
  const script = extractBridgeScript(html);
  const parentMessages: Array<Record<string, unknown>> = [];
  type Listener = (ev: { data?: unknown }) => void;
  const listeners = new Map<string, Listener[]>();
  const state = {
    href: 'about:srcdoc',
    pathname: opts?.initialPathname ?? '/',
    search: opts?.initialSearch ?? '',
    hash: opts?.initialHash ?? '',
    state: null as unknown,
  };
  const history = {
    state: null as unknown,
    pushState(s: unknown, _t: string, url: string) {
      history.state = s;
      applyUrl(url);
    },
    replaceState(s: unknown, _t: string, url: string) {
      history.state = s;
      applyUrl(url);
    },
  };
  function applyUrl(url: string) {
    const hashIdx = url.indexOf('#');
    const searchIdx = url.indexOf('?');
    const pathEnd =
      searchIdx >= 0
        ? searchIdx
        : hashIdx >= 0
          ? hashIdx
          : url.length;
    state.pathname = url.slice(0, pathEnd) || state.pathname;
    state.search =
      searchIdx >= 0
        ? url.slice(searchIdx, hashIdx >= 0 ? hashIdx : url.length)
        : '';
    state.hash = hashIdx >= 0 ? url.slice(hashIdx) : '';
    state.href = state.pathname + state.search + state.hash;
  }
  const location = {
    get href() {
      return state.href;
    },
    get pathname() {
      return state.pathname;
    },
    get search() {
      return state.search;
    },
    get hash() {
      return state.hash;
    },
    set hash(v: string) {
      state.hash = v.startsWith('#') ? v : `#${v}`;
      state.href = state.pathname + state.search + state.hash;
      // Browsers dispatch hashchange on direct location.hash assignment;
      // mirror that so the bridge's listener path is exercised.
      const lst = listeners.get('hashchange') ?? [];
      for (const l of lst) l({ data: null });
    },
  };
  const win = {
    parent: {
      postMessage: (data: unknown) => {
        parentMessages.push(data as Record<string, unknown>);
      },
    },
    addEventListener(type: string, listener: Listener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    dispatchEvent(ev: { type: string; state?: unknown }) {
      const list = listeners.get(ev.type) ?? [];
      for (const l of list) l({ data: ev });
    },
  };
  const documentMock = {
    readyState: 'complete',
    addEventListener: () => {},
  };
  const sandbox: Record<string, unknown> = {
    window: win,
    document: documentMock,
    history,
    location,
    setTimeout: (fn: () => void) => fn(),
    HashChangeEvent: class HashChangeEvent {
      type: string;
      oldURL: string;
      newURL: string;
      constructor(_type: string, init: { oldURL: string; newURL: string }) {
        this.type = 'hashchange';
        this.oldURL = init.oldURL;
        this.newURL = init.newURL;
      }
    },
    PopStateEvent: class PopStateEvent {
      type: string;
      state: unknown;
      constructor(_type: string, init: { state: unknown }) {
        this.type = 'popstate';
        this.state = init.state;
      }
    },
  };
  // Wire window to itself so `window.parent !== window` evaluates correctly.
  (win as unknown as { window: unknown }).window = win;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  return {
    parentMessages,
    triggerEvent: (type, ev) => {
      const list = listeners.get(type) ?? [];
      for (const l of list) l(ev ?? { data: null });
    },
    state,
  };
}

describe('injectPreviewNavigationRestore reporter (regression: bridge must report current route)', () => {
  it('posts od:preview-navigation on boot when navigation is provided', () => {
    const html = buildSrcdoc('<html><body></body></html>', {
      initialNavigation: { pathname: '/a', search: '', hash: '#/dash', state: { tab: 'x' } },
    });
    const bridge = runBridge(html, { initialPathname: '/' });
    const post = bridge.parentMessages.find((m) => m.type === 'od:preview-navigation');
    expect(post).toMatchObject({
      type: 'od:preview-navigation',
      hash: '#/dash',
    });
  });

  it('replies to od:preview-navigation-request even when nothing has changed', () => {
    const html = buildSrcdoc('<html><body></body></html>', { initialNavigation: null });
    const bridge = runBridge(html, { initialPathname: '/page' });
    const before = bridge.parentMessages.length;
    bridge.triggerEvent('message', { data: { type: 'od:preview-navigation-request' } });
    const after = bridge.parentMessages.filter((m) => m.type === 'od:preview-navigation').length;
    expect(after).toBeGreaterThan(before);
  });

  it('dedupes redundant od:preview-navigation reports to the same URL', () => {
    const html = buildSrcdoc('<html><body></body></html>', {
      initialNavigation: { hash: '#/section' },
    });
    const bridge = runBridge(html, { initialPathname: '/' });
    const before = bridge.parentMessages.filter((m) => m.type === 'od:preview-navigation').length;
    // Trigger hashchange listener; bridge will try to post but URL hasn't moved.
    bridge.triggerEvent('hashchange');
    bridge.triggerEvent('popstate');
    const after = bridge.parentMessages.filter((m) => m.type === 'od:preview-navigation').length;
    expect(after).toBe(before);
  });
});

describe('injectPreviewNavigationRestore restore (regression: dispatch hashchange on hash-only restore)', () => {
  it('dispatches a hashchange event when the restored URL changes the hash', () => {
    const html = buildSrcdoc('<html><body></body></html>', {
      initialNavigation: { hash: '#/section-after' },
    });
    let hashchangeFired = 0;
    const script = extractBridgeScript(html);
    type Listener = (ev: { data?: unknown }) => void;
    const listeners = new Map<string, Listener[]>();
    const sbState = {
      href: '/page',
      pathname: '/page',
      search: '',
      hash: '#/section-before',
      state: null as unknown,
    };
    const sbHistory = {
      state: null as unknown,
      replaceState(s: unknown, _t: string, url: string) {
        sbHistory.state = s;
        const hashIdx = url.indexOf('#');
        sbState.pathname = url.slice(0, hashIdx >= 0 ? hashIdx : url.length) || sbState.pathname;
        sbState.hash = hashIdx >= 0 ? url.slice(hashIdx) : '';
        sbState.href = sbState.pathname + sbState.search + sbState.hash;
      },
      pushState() {},
    };
    const sbWin = {
      parent: { postMessage: () => {} },
      addEventListener(t: string, l: Listener) {
        const list = listeners.get(t) ?? [];
        list.push(l);
        listeners.set(t, list);
      },
      dispatchEvent(ev: { type: string }) {
        if (ev.type === 'hashchange') hashchangeFired++;
      },
    };
    (sbWin as unknown as { window: unknown }).window = sbWin;
    const sandbox: Record<string, unknown> = {
      window: sbWin,
      document: { readyState: 'complete', addEventListener: () => {} },
      history: sbHistory,
      location: sbState,
      setTimeout: (fn: () => void) => fn(),
      HashChangeEvent: class HashChangeEvent {
        type = 'hashchange';
        oldURL: string;
        newURL: string;
        constructor(_t: string, init: { oldURL: string; newURL: string }) {
          this.oldURL = init.oldURL;
          this.newURL = init.newURL;
        }
      },
      PopStateEvent: class PopStateEvent {
        type = 'popstate';
        state: unknown;
        constructor(_t: string, init: { state: unknown }) {
          this.state = init.state;
        }
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(script, sandbox);
    expect(hashchangeFired).toBeGreaterThanOrEqual(1);
  });
});
