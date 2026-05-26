import { accessSync, constants, statSync } from 'node:fs';
import { delimiter } from 'node:path';
import path from 'node:path';
import { homedir } from 'node:os';
import { wellKnownUserToolchainBins } from '@open-design/platform';
import { expandHomePath } from './paths.js';
import type {
  RuntimeAgentDef,
  RuntimeExecutableCandidate,
  RuntimeExecutableCandidateSource,
} from './types.js';

export const AGENT_BIN_ENV_KEYS = new Map<string, string>([
  ['aider', 'AIDER_BIN'],
  ['claude', 'CLAUDE_BIN'],
  ['codex', 'CODEX_BIN'],
  ['copilot', 'COPILOT_BIN'],
  ['cursor-agent', 'CURSOR_AGENT_BIN'],
  ['deepseek', 'DEEPSEEK_BIN'],
  ['devin', 'DEVIN_BIN'],
  ['gemini', 'GEMINI_BIN'],
  ['hermes', 'HERMES_BIN'],
  ['kimi', 'KIMI_BIN'],
  ['kiro', 'KIRO_BIN'],
  ['kilo', 'KILO_BIN'],
  ['opencode', 'OPENCODE_BIN'],
  ['pi', 'PI_BIN'],
  ['qoder', 'QODER_BIN'],
  ['qwen', 'QWEN_BIN'],
  ['trae-cli', 'TRAE_CLI_BIN'],
  ['vibe', 'VIBE_BIN'],
]);

const TOOLCHAIN_DIR_CACHE_TTL_MS = 5000;
let cachedToolchainHome: string | null = null;
let cachedToolchainDirs: string[] | null = null;
let cachedToolchainDirsAt = 0;

function userToolchainDirs() {
  const homeOverride = process.env.OD_AGENT_HOME;
  const home = homeOverride || homedir();
  const now = Date.now();
  if (
    cachedToolchainHome === home &&
    cachedToolchainDirs &&
    now - cachedToolchainDirsAt < TOOLCHAIN_DIR_CACHE_TTL_MS
  ) {
    return cachedToolchainDirs;
  }
  cachedToolchainHome = home;
  cachedToolchainDirsAt = now;
  // When OD_AGENT_HOME is set, scope the search strictly to the override
  // home: skip Homebrew / /usr/local *and* pass an empty env so that a
  // developer or CI runner with NPM_CONFIG_PREFIX / npm_config_prefix
  // exported can't leak the real machine's <prefix>/bin into a sandboxed
  // detection run. Without this the agents.test.ts cases that build a
  // tmp home would be machine-environment-dependent.
  cachedToolchainDirs = wellKnownUserToolchainBins({
    home,
    includeSystemBins: process.platform !== 'win32' && !homeOverride,
    env: homeOverride ? {} : process.env,
  });
  return cachedToolchainDirs;
}

function resolvePathDirs(): Array<{ dir: string; source: 'path' | 'known' }> {
  const seen = new Set();
  const dirs = [
    ...(process.env.PATH || '')
      .split(delimiter)
      .map((dir) => ({ dir, source: 'path' as const })),
    // GUI launchers (macOS .app bundles, Linux .desktop files) often start
    // with a minimal PATH. Include common user-level CLI install locations
    // so agent detection matches the user's shell-installed tools,
    // especially Node version managers.
    ...userToolchainDirs().map((dir) => ({ dir, source: 'known' as const })),
  ];
  return dirs.filter(({ dir }) => {
    if (!dir || seen.has(dir)) return false;
    seen.add(dir);
    return true;
  });
}

export function resolveOnPath(bin: string): string | null {
  return findExecutableCandidatesOnPath(bin, 'path')[0]?.path ?? null;
}

function findExecutableCandidatesOnPath(
  bin: string,
  source: RuntimeExecutableCandidateSource,
): RuntimeExecutableCandidate[] {
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
      : [''];
  const candidates: RuntimeExecutableCandidate[] = [];
  for (const { dir, source: dirSource } of resolvePathDirs()) {
    const candidateSource = dirSource === 'known' ? 'known' : source;
    for (const ext of exts) {
      const full = path.join(dir, bin + ext);
      if (isInvocableFile(full)) {
        candidates.push({
          path: full,
          bin,
          source: candidateSource,
          available: true,
          selected: false,
        });
      }
    }
  }
  return candidates;
}

function isInvocableFile(filePath: string): boolean {
  try {
    if (!statSync(filePath).isFile()) return false;
    if (process.platform === 'win32') return looksExecutableOnWindows(filePath);
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function looksExecutableOnWindows(filePath: string): boolean {
  const ext = path.extname(filePath).trim().toUpperCase();
  if (!ext) return false;
  const executableExts = (process.env.PATHEXT || '.EXE;.CMD;.BAT')
    .split(';')
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  return executableExts.includes(ext);
}

// Resolve the first available binary for an agent definition. Tries
// `def.bin` first, then walks `def.fallbackBins` in order. Used for
// agents whose forks ship under a different binary name but speak the
// exact same CLI (Claude Code → OpenClaude, issue #235). Returns null
// when no candidate is on PATH.
function configuredExecutableOverride(
  def: RuntimeAgentDef,
  configuredEnv: Record<string, string> = {},
): string | null {
  const envKey = AGENT_BIN_ENV_KEYS.get(def?.id);
  if (!envKey) return null;
  const raw = configuredEnv?.[envKey];
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const expanded = expandHomePath(raw.trim());
  if (!path.isAbsolute(expanded)) return null;
  try {
    if (!statSync(expanded).isFile()) return null;
    if (process.platform === 'win32') {
      if (!looksExecutableOnWindows(expanded)) return null;
    } else {
      accessSync(expanded, constants.X_OK);
    }
    return expanded;
  } catch {
    return null;
  }
}

function configuredExecutableCandidate(
  def: RuntimeAgentDef,
  configuredEnv: Record<string, string> = {},
): RuntimeExecutableCandidate | null {
  const configuredOverridePath = configuredExecutableOverride(def, configuredEnv);
  if (!configuredOverridePath) return null;
  return {
    path: configuredOverridePath,
    bin: path.basename(configuredOverridePath),
    source: 'configured',
    available: true,
    selected: false,
  };
}

export function resolveAgentExecutable(
  def: RuntimeAgentDef,
  configuredEnv: Record<string, string> = {},
): string | null {
  return inspectAgentExecutableResolution(def, configuredEnv).selectedPath;
}

export function inspectAgentExecutableResolution(
  def: RuntimeAgentDef,
  configuredEnv: Record<string, string> = {},
): {
  configuredOverridePath: string | null;
  pathResolvedPath: string | null;
  selectedPath: string | null;
  executableCandidates: RuntimeExecutableCandidate[];
} {
  if (!def?.bin) {
    return {
      configuredOverridePath: null,
      pathResolvedPath: null,
      selectedPath: null,
      executableCandidates: [],
    };
  }
  const executableCandidates = inspectAgentExecutableCandidates(def, configuredEnv);
  const configuredOverridePath =
    executableCandidates.find((candidate) => candidate.source === 'configured')?.path ?? null;
  const candidates = [
    def.bin,
    ...(Array.isArray(def.fallbackBins) ? def.fallbackBins : []),
  ];
  let pathResolvedPath: string | null = null;
  for (const bin of candidates) {
    const resolved = resolveOnPath(bin);
    if (resolved) {
      pathResolvedPath = resolved;
      break;
    }
  }
  return {
    configuredOverridePath,
    pathResolvedPath,
    selectedPath: configuredOverridePath || pathResolvedPath,
    executableCandidates: executableCandidates.map((candidate) => ({
      ...candidate,
      selected: candidate.path === (configuredOverridePath || pathResolvedPath),
    })),
  };
}

export function inspectAgentExecutableCandidates(
  def: RuntimeAgentDef,
  configuredEnv: Record<string, string> = {},
): RuntimeExecutableCandidate[] {
  if (!def?.bin) return [];
  const seen = new Set<string>();
  const out: RuntimeExecutableCandidate[] = [];
  const add = (candidate: RuntimeExecutableCandidate | null) => {
    if (!candidate || seen.has(candidate.path)) return;
    seen.add(candidate.path);
    out.push(candidate);
  };
  add(configuredExecutableCandidate(def, configuredEnv));
  for (const bin of [
    def.bin,
    ...(Array.isArray(def.fallbackBins) ? def.fallbackBins : []),
  ]) {
    const source: RuntimeExecutableCandidateSource =
      bin === def.bin ? 'path' : 'fallback';
    for (const candidate of findExecutableCandidatesOnPath(bin, source)) {
      add(candidate);
    }
  }
  return out;
}
