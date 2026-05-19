import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePackagedNamespacePaths } from "../src/paths.js";
import type { PackagedConfig } from "../src/config.js";

function fakeConfig(): PackagedConfig {
  return {
    appVersion: null,
    daemonCliEntry: null,
    daemonSidecarEntry: null,
    namespace: "release-stable-win",
    namespaceBaseRoot: join("C:", "Users", "Fred", "AppData", "Roaming", "Open Design", "namespaces"),
    nodeCommand: null,
    posthogHost: null,
    posthogKey: null,
    resourceRoot: join("C:", "Program Files", "Open Design", "resources", "open-design"),
    telemetryRelayUrl: null,
    webOutputMode: "server",
    webSidecarEntry: null,
    webStandaloneRoot: null,
  };
}

describe("resolvePackagedNamespacePaths", () => {
  it("models update downloads as a namespace-scoped root beside data", () => {
    const config = fakeConfig();
    const paths = resolvePackagedNamespacePaths(config, config.namespace);

    expect(paths.namespaceRoot).toBe(join(config.namespaceBaseRoot, config.namespace));
    expect(paths.dataRoot).toBe(join(paths.namespaceRoot, "data"));
    expect(paths.updateRoot).toBe(join(paths.namespaceRoot, "updates"));
    expect(paths.installerObservationRoot).toBe(join(paths.dataRoot, "observations", "installer"));
  });

  it("rejects namespace overrides that would escape the namespace base root", () => {
    const config: PackagedConfig = {
      appVersion: "1.2.3",
      daemonCliEntry: null,
      daemonSidecarEntry: null,
      namespace: "release",
      namespaceBaseRoot: "/tmp/open-design-packaged/namespaces",
      nodeCommand: null,
      resourceRoot: "/tmp/open-design-packaged/resources",
      telemetryRelayUrl: null,
      posthogKey: null,
      posthogHost: null,
      webSidecarEntry: null,
      webStandaloneRoot: null,
      webOutputMode: "server",
    };

    expect(() => resolvePackagedNamespacePaths(config, "../release")).toThrow(/namespace/);
  });

  it("defaults daemon dataRoot to the namespace-scoped packaged data directory", () => {
    const config = fakeConfig();

    expect(resolvePackagedNamespacePaths(config, config.namespace).dataRoot).toBe(
      join(config.namespaceBaseRoot, config.namespace, "data"),
    );
  });

  it("uses OD_DATA_DIR as the packaged daemon dataRoot when provided", () => {
    const config = fakeConfig();
    const override = join("C:", "Users", "Fred", "MyProject", "design", ".od");

    expect(
      resolvePackagedNamespacePaths(config, config.namespace, { OD_DATA_DIR: override }).dataRoot,
    ).toBe(override);
  });

  it("forwards the OD_DATA_DIR-resolved dataRoot into sidecar launch paths", () => {
    const config = fakeConfig();
    const override = join("C:", "Users", "Fred", "MyProject", "design", ".od");
    const paths = resolvePackagedNamespacePaths(config, config.namespace, {
      OD_DATA_DIR: override,
    });

    expect(paths.dataRoot).toBe(override);
    expect(paths.namespaceRoot).toBe(join(config.namespaceBaseRoot, config.namespace));
    expect(paths.runtimeRoot).toBe(join(config.namespaceBaseRoot, config.namespace, "runtime"));
  });

  it("does not read process.env implicitly so headless can keep namespace-root OD_DATA_DIR semantics", () => {
    const config = fakeConfig();
    const original = process.env.OD_DATA_DIR;
    try {
      process.env.OD_DATA_DIR = join("C:", "Users", "Fred", "MyProject", "design", ".od");
      expect(resolvePackagedNamespacePaths(config).dataRoot).toBe(
        join(config.namespaceBaseRoot, config.namespace, "data"),
      );
    } finally {
      if (original == null) delete process.env.OD_DATA_DIR;
      else process.env.OD_DATA_DIR = original;
    }
  });

  it("resolves relative OD_DATA_DIR values against the packaged process cwd", () => {
    const config = fakeConfig();

    expect(
      resolvePackagedNamespacePaths(config, config.namespace, { OD_DATA_DIR: "project/.od" }).dataRoot,
    ).toBe(resolve("project/.od"));
  });
});
