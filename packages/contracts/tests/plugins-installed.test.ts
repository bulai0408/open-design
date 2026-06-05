import { describe, expect, it } from 'vitest';

import {
  PLUGIN_UNINSTALL_NOT_FOUND_CODE,
  PluginUninstallOutcomeSchema,
} from '../src/plugins/installed.js';

describe('plugin installed contracts', () => {
  it('defines an explicit not-found uninstall outcome for daemon/web consumers', () => {
    const parsed = PluginUninstallOutcomeSchema.parse({
      ok: false,
      code: PLUGIN_UNINSTALL_NOT_FOUND_CODE,
      notFound: true,
      warnings: ['Registry row was already missing'],
      message: 'Plugin not found.',
    });

    expect(parsed).toEqual({
      ok: false,
      code: 'plugin_not_found',
      notFound: true,
      warnings: ['Registry row was already missing'],
      message: 'Plugin not found.',
    });
  });

  it('defines an explicit bundled-plugin uninstall outcome for non-removable bundled plugins', () => {
    const parsed = PluginUninstallOutcomeSchema.parse({
      ok: false,
      code: 'bundled-plugin',
      warnings: [],
      message: 'Bundled plugins are managed by daemon upgrades.',
    });

    expect(parsed).toEqual({
      ok: false,
      code: 'bundled-plugin',
      warnings: [],
      message: 'Bundled plugins are managed by daemon upgrades.',
    });
  });
});
