// Marketplace registry — plan §3.B4 / spec §6 / §7 / §11.5 / §16 Phase 3
// (entry slice).
//
// Stores user-configured federated catalog indexes in
// `plugin_marketplaces`. The actual `od plugin install <name>` resolution
// through these catalogs lands in Phase 3 alongside the trust UI; this
// module is the storage + refresh half so the desktop / CLI can already
// register and inspect catalogs.
//
// We intentionally treat the catalog body as opaque JSON in v1 — Zod
// validation lives in `@open-design/plugin-runtime`'s parser and we only
// store what the parser returns. Trust default mirrors §9: a freshly
// added user-supplied marketplace is `restricted` (discovery only)
// unless `--trust` is passed.

import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import type Database from 'better-sqlite3';
import {
  parseMarketplace,
  type MarketplaceParseResult,
} from '@open-design/plugin-runtime';
import {
  OPEN_DESIGN_PLUGIN_SPEC_VERSION,
  type MarketplaceManifest,
} from '@open-design/contracts';
import {
  parsePluginSpecifier,
  resolveMarketplaceEntryVersion,
} from '../registry/versioning.js';

type SqliteDb = Database.Database;

export type MarketplaceTrustTier = 'official' | 'trusted' | 'restricted';

export interface MarketplaceRow {
  id: string;
  url: string;
  specVersion: string;
  version: string;
  trust: MarketplaceTrustTier;
  manifest: MarketplaceManifest;
  addedAt: number;
  refreshedAt: number;
}

export interface AddMarketplaceInput {
  url: string;
  // Pluggable HTTPS fetcher; tests inject a stub. Production injects the
  // global fetch.
  fetcher?: MarketplaceFetcher;
  trust?: MarketplaceTrustTier;
}

export type MarketplaceFetchResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
};

export type MarketplaceFetcher = (url: string) => Promise<MarketplaceFetchResponse>;

export interface AddMarketplaceResult {
  ok: true;
  row: MarketplaceRow;
  warnings: string[];
}

export interface AddMarketplaceFailure {
  ok: false;
  status: number;
  message: string;
  errors?: string[];
}

export interface EnsureMarketplaceManifestInput {
  id: string;
  url: string;
  trust: MarketplaceTrustTier;
  manifestText: string;
  now?: number;
}

export type MarketplaceAuthState =
  | 'authenticated'
  | 'not-authenticated'
  | 'not-installed'
  | 'unknown';

export interface MarketplaceAuthStatus {
  ok: true;
  marketplaceId: string;
  host: string;
  authenticated: boolean;
  status: MarketplaceAuthState;
  login?: string;
  message: string;
  log: string[];
}

export interface MarketplaceAuthLoginStarted {
  ok: true;
  marketplaceId: string;
  host: string;
  status: 'started';
  message: string;
}

export interface MarketplaceAuthFailure {
  ok: false;
  status: number;
  code: string;
  message: string;
  host?: string;
  log?: string[];
}

type ExecFileResult = {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  code?: string | number;
  error?: unknown;
};

type MarketplaceAuthDeps = {
  execFile?: (command: string, args: string[], opts?: { timeout?: number }) => Promise<ExecFileResult>;
  spawnDetached?: (command: string, args: string[]) => Promise<{ ok: boolean; error?: unknown }>;
};

const HTTPS_RE = /^https:\/\//i;
const DEFAULT_MARKETPLACE_REPO = 'nexu-io/open-design';
const DEFAULT_MARKETPLACE_REPO_REF = 'main';
const DEFAULT_MARKETPLACE_REGISTRY_PATH = 'plugins/registry';
const PUBLIC_MARKETPLACE_BASE_URL = 'https://open-design.ai/marketplace';
const PUBLIC_PLUGINS_BASE_URL = 'https://open-design.ai/plugins';

function marketplaceRegistryRepo(): string {
  return (process.env.OD_MARKETPLACE_REPO?.trim() || DEFAULT_MARKETPLACE_REPO)
    .replace(/^\/+|\/+$/g, '');
}

export function marketplaceRegistryBaseUrl(): string {
  const explicit = process.env.OD_MARKETPLACE_REGISTRY_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const repo = marketplaceRegistryRepo();
  const ref = (process.env.OD_MARKETPLACE_REPO_REF?.trim() || DEFAULT_MARKETPLACE_REPO_REF)
    .replace(/^\/+|\/+$/g, '');
  const registryPath = (process.env.OD_MARKETPLACE_REGISTRY_PATH?.trim() || DEFAULT_MARKETPLACE_REGISTRY_PATH)
    .replace(/^\/+|\/+$/g, '');
  return `https://raw.githubusercontent.com/${repo}/${ref}/${registryPath}`;
}

export function marketplaceManifestUrlForRegistry(id: string): string {
  const registryId = id.trim().replace(/^\/+|\/+$/g, '');
  return `${marketplaceRegistryBaseUrl()}/${registryId}/open-design-marketplace.json`;
}

function registryIdFromBaseUrl(url: string, baseUrl: string): string | null {
  const base = baseUrl.replace(/\/+$/, '');
  if (!url.startsWith(`${base}/`) || !url.endsWith('/open-design-marketplace.json')) {
    return null;
  }
  const id = url
    .slice(base.length + 1)
    .replace(/\/open-design-marketplace\.json$/, '');
  return id && !id.includes('/') ? id : null;
}

export function marketplaceRegistryIdFromUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  const configuredId = registryIdFromBaseUrl(trimmed, marketplaceRegistryBaseUrl());
  if (configuredId) return configuredId;

  const publicBases = [PUBLIC_MARKETPLACE_BASE_URL, PUBLIC_PLUGINS_BASE_URL];
  for (const base of publicBases) {
    if (trimmed === `${base}/open-design-marketplace.json`) return 'official';
    if (trimmed.startsWith(`${base}/`) && trimmed.endsWith('/open-design-marketplace.json')) {
      const id = trimmed
        .slice(base.length + 1)
        .replace(/\/open-design-marketplace\.json$/, '');
      if (id && !id.includes('/')) return id;
    }
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'raw.githubusercontent.com') {
      return null;
    }
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 6) return null;
    const [owner, repo] = parts;
    const allowedRepos = new Set([DEFAULT_MARKETPLACE_REPO, marketplaceRegistryRepo()]);
    if (!allowedRepos.has(`${owner}/${repo}`)) return null;
    const marker = parts.findIndex((part, index) =>
      part === 'plugins' && parts[index + 1] === 'registry',
    );
    const id = marker >= 0 ? parts[marker + 2] : undefined;
    const filename = marker >= 0 ? parts[marker + 3] : undefined;
    return id && filename === 'open-design-marketplace.json' ? id : null;
  } catch {
    return null;
  }
}

export function resolveMarketplaceFetchUrl(url: string): string {
  const trimmed = url.trim();
  const registryId = marketplaceRegistryIdFromUrl(trimmed);
  return registryId ? marketplaceManifestUrlForRegistry(registryId) : trimmed;
}

function normalizeMarketplaceTrust(value: unknown): MarketplaceTrustTier {
  return value === 'official' || value === 'trusted' ? value : 'restricted';
}

export async function addMarketplace(
  db: SqliteDb,
  input: AddMarketplaceInput,
): Promise<AddMarketplaceResult | AddMarketplaceFailure> {
  const url = resolveMarketplaceFetchUrl(input.url);
  if (!HTTPS_RE.test(url)) {
    return {
      ok: false,
      status: 400,
      message: 'marketplace url must use https://',
    };
  }
  const fetcher = input.fetcher ?? defaultFetcher;
  let resp;
  try {
    resp = await fetcher(url);
  } catch (err) {
    return {
      ok: false,
      status: 502,
      message: `Fetch failed: ${(err as Error).message ?? String(err)}`,
    };
  }
  if (!resp.ok) {
    return {
      ok: false,
      status: 502,
      message: `Marketplace fetch returned ${resp.status}`,
    };
  }
  const text = await resp.text();
  const parsed: MarketplaceParseResult = parseMarketplace(text);
  if (!parsed.ok) {
    return {
      ok: false,
      status: 422,
      message: 'marketplace manifest failed validation',
      errors: parsed.errors,
    };
  }
  const id = randomUUID();
  const now = Date.now();
  const trust = normalizeMarketplaceTrust(input.trust);
  db.prepare(
    `INSERT INTO plugin_marketplaces (id, url, spec_version, version, trust, manifest_json, added_at, refreshed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, url, parsed.manifest.specVersion, parsed.manifest.version, trust, text, now, now);
  return {
    ok: true,
    row: {
      id,
      url,
      specVersion: parsed.manifest.specVersion,
      version: parsed.manifest.version,
      trust,
      manifest: parsed.manifest,
      addedAt: now,
      refreshedAt: now,
    },
    warnings: [],
  };
}

export function ensureMarketplaceManifest(
  db: SqliteDb,
  input: EnsureMarketplaceManifestInput,
): AddMarketplaceResult | AddMarketplaceFailure {
  const parsed = parseMarketplace(input.manifestText);
  if (!parsed.ok) {
    return {
      ok: false,
      status: 422,
      message: 'marketplace manifest failed validation',
      errors: parsed.errors,
    };
  }
  const now = input.now ?? Date.now();
  const trust = normalizeMarketplaceTrust(input.trust);
  const existing = getMarketplace(db, input.id);
  db.prepare(`
    INSERT INTO plugin_marketplaces (id, url, spec_version, version, trust, manifest_json, added_at, refreshed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      url = excluded.url,
      spec_version = excluded.spec_version,
      version = excluded.version,
      trust = excluded.trust,
      manifest_json = excluded.manifest_json,
      refreshed_at = excluded.refreshed_at
  `).run(
    input.id,
    input.url,
    parsed.manifest.specVersion,
    parsed.manifest.version,
    trust,
    input.manifestText,
    existing?.addedAt ?? now,
    now,
  );
  return {
    ok: true,
    row: {
      id: input.id,
      url: input.url,
      specVersion: parsed.manifest.specVersion,
      version: parsed.manifest.version,
      trust,
      manifest: parsed.manifest,
      addedAt: existing?.addedAt ?? now,
      refreshedAt: now,
    },
    warnings: [],
  };
}

export function listMarketplaces(db: SqliteDb): MarketplaceRow[] {
  const rows = db
    .prepare(`SELECT id, url, spec_version, version, trust, manifest_json, added_at, refreshed_at FROM plugin_marketplaces ORDER BY added_at ASC`)
    .all() as Array<{
      id: string;
      url: string;
      spec_version: string;
      version: string;
      trust: MarketplaceTrustTier;
      manifest_json: string;
      added_at: number;
      refreshed_at: number;
    }>;
  return rows.map((r) => {
    const manifest = safeParseManifest(r.manifest_json);
    return {
      id: r.id,
      url: r.url,
      specVersion: r.spec_version || manifest.specVersion,
      version: r.version === '0.0.0' ? manifest.version : r.version,
      trust: normalizeMarketplaceTrust(r.trust),
      manifest,
      addedAt: r.added_at,
      refreshedAt: r.refreshed_at,
    };
  });
}

export function getMarketplace(db: SqliteDb, id: string): MarketplaceRow | null {
  const row = db
    .prepare(`SELECT id, url, spec_version, version, trust, manifest_json, added_at, refreshed_at FROM plugin_marketplaces WHERE id = ?`)
    .get(id) as
      | undefined
      | {
          id: string;
          url: string;
          spec_version: string;
          version: string;
          trust: MarketplaceTrustTier;
          manifest_json: string;
          added_at: number;
          refreshed_at: number;
        };
  if (!row) return null;
  const manifest = safeParseManifest(row.manifest_json);
  return {
    id: row.id,
    url: row.url,
    specVersion: row.spec_version || manifest.specVersion,
    version: row.version === '0.0.0' ? manifest.version : row.version,
    trust: normalizeMarketplaceTrust(row.trust),
    manifest,
    addedAt: row.added_at,
    refreshedAt: row.refreshed_at,
  };
}

export function removeMarketplace(db: SqliteDb, id: string): boolean {
  const info = db.prepare(`DELETE FROM plugin_marketplaces WHERE id = ?`).run(id);
  return info.changes > 0;
}

export function setMarketplaceTrust(
  db: SqliteDb,
  id: string,
  trust: MarketplaceTrustTier,
): MarketplaceRow | null {
  const info = db.prepare(`UPDATE plugin_marketplaces SET trust = ? WHERE id = ?`).run(trust, id);
  if (info.changes === 0) return null;
  return getMarketplace(db, id);
}

export async function getMarketplaceAuthStatus(
  db: SqliteDb,
  id: string,
  deps: MarketplaceAuthDeps = {},
): Promise<MarketplaceAuthStatus | MarketplaceAuthFailure> {
  const row = getMarketplace(db, id);
  if (!row) {
    return {
      ok: false,
      status: 404,
      code: 'marketplace-not-found',
      message: 'marketplace not found',
    };
  }
  const host = inferMarketplaceGithubHost(row.url);
  const run = deps.execFile ?? execFileBuffered;
  const version = await run('gh', ['--version'], { timeout: 10_000 });
  if (!version.ok) {
    return {
      ok: true,
      marketplaceId: id,
      host,
      authenticated: false,
      status: 'not-installed',
      message: 'GitHub CLI is not installed. Install gh to authenticate private marketplace catalogs.',
      log: compactLog(version.stderr, version.stdout, 'gh --version failed'),
    };
  }
  const auth = await run('gh', ['auth', 'status', '--hostname', host], { timeout: 10_000 });
  const log = compactLog(auth.stderr, auth.stdout);
  if (!auth.ok) {
    return {
      ok: true,
      marketplaceId: id,
      host,
      authenticated: false,
      status: 'not-authenticated',
      message: `GitHub CLI is not authenticated for ${host}.`,
      log,
    };
  }
  const login = extractGhLogin(log.join('\n'));
  return {
    ok: true,
    marketplaceId: id,
    host,
    authenticated: true,
    status: 'authenticated',
    ...(login ? { login } : {}),
    message: `GitHub CLI is authenticated for ${host}.`,
    log,
  };
}

export async function loginMarketplaceAuth(
  db: SqliteDb,
  id: string,
  deps: MarketplaceAuthDeps = {},
): Promise<MarketplaceAuthLoginStarted | MarketplaceAuthFailure> {
  const row = getMarketplace(db, id);
  if (!row) {
    return {
      ok: false,
      status: 404,
      code: 'marketplace-not-found',
      message: 'marketplace not found',
    };
  }
  const host = inferMarketplaceGithubHost(row.url);
  const run = deps.execFile ?? execFileBuffered;
  const version = await run('gh', ['--version'], { timeout: 10_000 });
  if (!version.ok) {
    return {
      ok: false,
      status: 424,
      code: 'gh-not-installed',
      host,
      message: 'GitHub CLI is not installed. Install gh from https://cli.github.com/ and retry.',
      log: compactLog(version.stderr, version.stdout, 'gh --version failed'),
    };
  }
  const start = deps.spawnDetached ?? spawnDetached;
  const started = await start('gh', ['auth', 'login', '--hostname', host, '--web', '--clipboard']);
  if (!started.ok) {
    return {
      ok: false,
      status: 502,
      code: 'gh-login-start-failed',
      host,
      message: `Could not start GitHub CLI login for ${host}.`,
      log: compactLog(started.error instanceof Error ? started.error.message : String(started.error ?? '')),
    };
  }
  return {
    ok: true,
    marketplaceId: id,
    host,
    status: 'started',
    message: `Started GitHub CLI web login for ${host}. The one-time device code was copied to the clipboard; tokens stay in gh, not Open Design.`,
  };
}

export interface RefreshMarketplaceResult {
  ok: true;
  row: MarketplaceRow;
}

export async function refreshMarketplace(
  db: SqliteDb,
  id: string,
  fetcher?: AddMarketplaceInput['fetcher'],
): Promise<RefreshMarketplaceResult | AddMarketplaceFailure> {
  const existing = getMarketplace(db, id);
  if (!existing) {
    return { ok: false, status: 404, message: `marketplace ${id} not found` };
  }
  const useFetcher = fetcher ?? defaultFetcher;
  const url = resolveMarketplaceFetchUrl(existing.url);
  let resp;
  try {
    resp = await useFetcher(url);
  } catch (err) {
    return { ok: false, status: 502, message: `Fetch failed: ${(err as Error).message ?? String(err)}` };
  }
  if (!resp.ok) return { ok: false, status: 502, message: `Marketplace fetch returned ${resp.status}` };
  const text = await resp.text();
  const parsed = parseMarketplace(text);
  if (!parsed.ok) {
    return { ok: false, status: 422, message: 'marketplace manifest failed validation', errors: parsed.errors };
  }
  const now = Date.now();
  db.prepare(`UPDATE plugin_marketplaces SET url = ?, spec_version = ?, version = ?, manifest_json = ?, refreshed_at = ? WHERE id = ?`)
    .run(url, parsed.manifest.specVersion, parsed.manifest.version, text, now, id);
  return {
    ok: true,
    row: {
      ...existing,
      url,
      specVersion: parsed.manifest.specVersion,
      version: parsed.manifest.version,
      manifest: parsed.manifest,
      refreshedAt: now,
    },
  };
}

export async function fetchMarketplaceUrl(url: string): Promise<MarketplaceFetchResponse> {
  const response = await fetch(url, { redirect: 'follow' });
  if (response.ok || !shouldRetryMarketplaceFetchWithGh(url, response.status)) {
    return {
      ok: response.ok,
      status: response.status,
      text: () => response.text(),
    };
  }

  const host = inferMarketplaceGithubHost(url);
  const token = await readGhAuthToken(host);
  if (!token) {
    return {
      ok: response.ok,
      status: response.status,
      text: () => response.text(),
    };
  }

  const authed = await fetch(url, {
    redirect: 'follow',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  return {
    ok: authed.ok,
    status: authed.status,
    text: () => authed.text(),
  };
}

async function defaultFetcher(url: string) {
  return fetchMarketplaceUrl(url);
}

function inferMarketplaceGithubHost(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname === 'raw.githubusercontent.com' || parsed.hostname === 'api.github.com') {
      return 'github.com';
    }
    return parsed.hostname || 'github.com';
  } catch {
    return 'github.com';
  }
}

function shouldRetryMarketplaceFetchWithGh(rawUrl: string, status: number): boolean {
  if (![401, 403, 404].includes(status)) return false;
  try {
    const parsed = new URL(rawUrl);
    return parsed.hostname === 'raw.githubusercontent.com'
      || parsed.hostname === 'api.github.com'
      || parsed.hostname === 'github.com'
      || parsed.hostname.endsWith('.github.com')
      || /github/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

async function readGhAuthToken(host: string): Promise<string | null> {
  const result = await execFileBuffered('gh', ['auth', 'token', '--hostname', host], { timeout: 10_000 });
  if (!result.ok) return null;
  const token = String(result.stdout ?? '').trim();
  return token.length > 0 ? token : null;
}

function compactLog(...values: Array<string | undefined>): string[] {
  return values
    .map((value) => String(value ?? '').trim())
    .filter((value) => value.length > 0);
}

function extractGhLogin(text: string): string | undefined {
  const accountMatch = /\baccount\s+([A-Za-z0-9-]+)\b/i.exec(text);
  if (accountMatch?.[1]) return accountMatch[1];
  const asMatch = /\bLogged in to [^\s]+ as\s+([A-Za-z0-9-]+)\b/i.exec(text);
  return asMatch?.[1];
}

function execFileBuffered(
  command: string,
  args: string[],
  opts: { timeout?: number } = {},
): Promise<ExecFileResult> {
  return new Promise((resolve) => {
    execFile(command, args, {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      ...opts,
    }, (error, stdout, stderr) => {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      resolve({
        ok: !error,
        ...(code ? { code } : {}),
        stdout: String(stdout ?? '').trim(),
        stderr: String(stderr ?? '').trim(),
        error,
      });
    });
  });
}

async function spawnDetached(
  command: string,
  args: string[],
): Promise<{ ok: boolean; error?: unknown }> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
      });
      child.once('error', (error) => resolve({ ok: false, error }));
      child.once('spawn', () => {
        child.unref();
        resolve({ ok: true });
      });
    } catch (error) {
      resolve({ ok: false, error });
    }
  });
}

function safeParseManifest(raw: string): MarketplaceManifest {
  try {
    const parsed = parseMarketplace(raw);
    if (parsed.ok) return parsed.manifest;
  } catch {
    // fall through
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('legacy marketplace manifest is not an object');
    }
    const legacy = parsed as Record<string, unknown>;
    const metadata = typeof legacy['metadata'] === 'object' && legacy['metadata'] !== null
      ? legacy['metadata'] as Record<string, unknown>
      : {};
    const plugins = Array.isArray(legacy?.['plugins'])
      ? (legacy['plugins'] as unknown[]).flatMap((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
          const obj = entry as Record<string, unknown>;
          const name = typeof obj['name'] === 'string' ? obj['name'] : '';
          const source = typeof obj['source'] === 'string' ? obj['source'] : '';
          if (!name || !source) return [];
          return [{
            ...obj,
            name,
            source,
            version: typeof obj['version'] === 'string' && obj['version'].length > 0
              ? obj['version']
              : '0.0.0',
          }];
        })
      : [];
    return {
      ...legacy,
      specVersion: typeof legacy['specVersion'] === 'string'
        ? legacy['specVersion'] as string
        : OPEN_DESIGN_PLUGIN_SPEC_VERSION,
      name: typeof legacy['name'] === 'string' ? legacy['name'] as string : 'unknown',
      version: typeof legacy['version'] === 'string' && (legacy['version'] as string).length > 0
        ? legacy['version'] as string
        : typeof metadata['version'] === 'string' && metadata['version'].length > 0
          ? metadata['version']
          : '0.0.0',
      plugins,
    } as MarketplaceManifest;
  } catch {
    // fall through
  }
  // Last-resort fallback: return a minimal shape so the caller doesn't
  // explode if a database row was stored before a schema patch.
  return {
    specVersion: OPEN_DESIGN_PLUGIN_SPEC_VERSION,
    name: 'unknown',
    version: '0.0.0',
    plugins: [],
  } as MarketplaceManifest;
}

// Plan §3.F3 / spec §7.2 + §6 — resolve a bare plugin name through
// every configured marketplace. Returns the first match (marketplace
// scan order matches `listMarketplaces` output, which is sorted by
// `added_at` ASC). The match carries the marketplace id (so audit
// trails record which catalog the install came from) and the resolved
// `source` string the installer can re-feed into `installPlugin()`.
//
// `restricted` marketplaces still resolve names — the plugin install
// path does NOT auto-trust the resulting plugin (it stays
// `restricted` per spec §9 unless the marketplace was explicitly
// `trusted` at add-time).
export interface ResolvedPluginEntry {
  marketplaceId: string;
  marketplaceUrl: string;
  marketplaceTrust: MarketplaceTrustTier;
  marketplaceSpecVersion: string;
  marketplaceVersion: string;
  pluginName: string;
  pluginVersion: string;
  source: string;
  ref?: string;
  manifestDigest?: string;
  archiveIntegrity?: string;
  description?: string;
}

export function resolvePluginInMarketplaces(
  db: SqliteDb,
  pluginName: string,
): ResolvedPluginEntry | null {
  const rows = listMarketplaces(db);
  const specifier = parsePluginSpecifier(pluginName);
  const target = specifier.name.trim().toLowerCase();
  if (!target) return null;
  for (const row of rows) {
    const entries = row.manifest.plugins ?? [];
    for (const entry of entries) {
      if (entry.name && entry.name.toLowerCase() === target) {
        const resolvedVersion = resolveMarketplaceEntryVersion(entry, specifier.range);
        if (!resolvedVersion) continue;
        const result: ResolvedPluginEntry = {
          marketplaceId:    row.id,
          marketplaceUrl:   row.url,
          marketplaceTrust: row.trust,
          marketplaceSpecVersion: row.specVersion,
          marketplaceVersion: row.version,
          pluginName:       entry.name,
          pluginVersion:    resolvedVersion.version,
          source:           resolvedVersion.source,
        };
        if (resolvedVersion.ref) result.ref = resolvedVersion.ref;
        if (resolvedVersion.manifestDigest) result.manifestDigest = resolvedVersion.manifestDigest;
        if (resolvedVersion.archiveIntegrity) result.archiveIntegrity = resolvedVersion.archiveIntegrity;
        if (entry.description) result.description = entry.description;
        return result;
      }
    }
  }
  return null;
}
