# ElevenLabs Audio Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ElevenLabs production-usable for both speech and sound effects in the Open Design audio pipeline.

**Architecture:** Keep one media provider entry, `elevenlabs`, and split behavior by audio kind inside the daemon dispatcher: `speech` routes to ElevenLabs text-to-speech and `sfx` routes to ElevenLabs sound generation. Keep the web and daemon model registries mirrored, let the Settings UI pick up the provider integration flag from that registry, and keep the agent-facing prompt contract explicit about voice IDs versus sound-effect prompts.

**Tech Stack:** TypeScript, Vitest, Node `fetch`, the existing Next.js web app, the Express daemon, and the current media registry / prompt contract modules.

---

## File Map

- Create: `apps/daemon/tests/media-elevenlabs.test.ts` - focused ElevenLabs speech and SFX dispatcher coverage.
- Modify: `apps/daemon/src/media.ts` - ElevenLabs renderers and dispatcher branches.
- Modify: `apps/daemon/src/media-models.ts` - mark ElevenLabs integrated and add its default base URL.
- Modify: `apps/web/src/media/models.ts` - mirror the daemon registry changes.
- Modify: `apps/web/src/components/NewProjectPanel.tsx` - allow ElevenLabs audio models through `supportedModels()`.
- Modify: `apps/daemon/src/prompts/media-contract.ts` - tell agents how to use `elevenlabs-v3` and `elevenlabs-sfx`.
- Modify: `apps/daemon/tests/system-prompt-template.test.ts` - pin the updated media-contract wording.
- Modify: `apps/web/tests/components/NewProjectPanel.test.ts` - pin ElevenLabs audio model visibility.
- Modify: `apps/web/tests/components/SettingsDialog.execution.test.tsx` - pin ElevenLabs provider row editability.

## Task 1: ElevenLabs speech renderer

**Files:**
- Create: `apps/daemon/tests/media-elevenlabs.test.ts`
- Modify: `apps/daemon/src/media.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateMedia } from '../src/media.js';

const TEST_BASE_URL = 'https://elevenlabs-gateway.example.test';
const MP3_BYTES = Buffer.from('ID3test-elevenlabs-speech');

describe('ElevenLabs media generation', () => {
  let root: string;
  let projectRoot: string;
  let projectsRoot: string;
  const realFetch = globalThis.fetch;
  const originalMediaConfigDir = process.env.OD_MEDIA_CONFIG_DIR;
  const originalDataDir = process.env.OD_DATA_DIR;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'od-elevenlabs-'));
    projectRoot = path.join(root, 'project-root');
    projectsRoot = path.join(projectRoot, '.od', 'projects');
    await mkdir(projectsRoot, { recursive: true });
    delete process.env.OD_MEDIA_CONFIG_DIR;
    delete process.env.OD_DATA_DIR;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    delete process.env.OD_ELEVENLABS_API_KEY;
    if (originalMediaConfigDir == null) {
      delete process.env.OD_MEDIA_CONFIG_DIR;
    } else {
      process.env.OD_MEDIA_CONFIG_DIR = originalMediaConfigDir;
    }
    if (originalDataDir == null) {
      delete process.env.OD_DATA_DIR;
    } else {
      process.env.OD_DATA_DIR = originalDataDir;
    }
    await rm(root, { recursive: true, force: true });
  });

  async function writeConfig(data: unknown) {
    const file = path.join(projectRoot, '.od', 'media-config.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(data), 'utf8');
  }

  it('renders ElevenLabs speech through the text-to-speech API', async () => {
    await writeConfig({
      providers: {
        elevenlabs: {
          baseUrl: TEST_BASE_URL,
          apiKey: 'eleven-test-key',
        },
      },
    });

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      expect(String(input)).toBe(
        `${TEST_BASE_URL}/v1/text-to-speech/voice-123?output_format=mp3_44100_128`,
      );
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        'content-type': 'application/json',
        'xi-api-key': 'eleven-test-key',
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        text: 'A warm product narrator.',
        model_id: 'eleven_v3',
        voice_settings: {
          stability: 1,
          similarity_boost: 1,
          style: 0,
          speed: 1,
          use_speaker_boost: true,
        },
      });
      return new Response(MP3_BYTES, {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateMedia({
      projectRoot,
      projectsRoot,
      projectId: 'project-1',
      surface: 'audio',
      model: 'elevenlabs-v3',
      prompt: 'A warm product narrator.',
      audioKind: 'speech',
      voice: 'voice-123',
      output: 'elevenlabs-speech.mp3',
    });

    expect(result.providerId).toBe('elevenlabs');
    expect(result.providerNote).toContain('elevenlabs/eleven_v3');
    expect(result.providerNote).toContain('voice-123');
    expect(result.name).toBe('elevenlabs-speech.mp3');
    expect(await readFile(path.join(projectsRoot, 'project-1', 'elevenlabs-speech.mp3'))).toEqual(
      MP3_BYTES,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir apps/daemon exec vitest run -c vitest.config.ts tests/media-elevenlabs.test.ts -t "renders ElevenLabs speech"
```

Expected: FAIL with `provider not configured: elevenlabs-v3` or an equivalent "no ElevenLabs renderer" failure before the renderer exists.

- [ ] **Step 3: Write the minimal implementation**

```ts
const ELEVENLABS_DEFAULT_BASE_URL = 'https://api.elevenlabs.io';
const ELEVENLABS_DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';
const ELEVENLABS_TTS_MODEL_MAP = {
  'elevenlabs-v3': 'eleven_v3',
} as Record<string, string>;

async function renderElevenLabsTTS(ctx: MediaContext, credentials: ProviderConfig): Promise<RenderResult> {
  const apiKey = credentials.apiKey?.trim() || '';
  if (!apiKey) {
    throw new Error(
      'no ElevenLabs API key - configure it in Settings or set OD_ELEVENLABS_API_KEY',
    );
  }
  const baseUrl = (credentials.baseUrl || ELEVENLABS_DEFAULT_BASE_URL).replace(/\/$/, '');
  const wireModel = ELEVENLABS_TTS_MODEL_MAP[ctx.model] || ctx.model;
  const text = (ctx.prompt && ctx.prompt.trim()) || 'This is a test.';
  const voiceId = (ctx.voice && ctx.voice.trim()) || ELEVENLABS_DEFAULT_VOICE_ID;

  const resp = await fetch(
    `${baseUrl}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: wireModel,
        voice_settings: {
          stability: 1,
          similarity_boost: 1,
          style: 0,
          speed: 1,
          use_speaker_boost: true,
        },
      }),
    },
  );
  const respText = await resp.text();
  if (!resp.ok) {
    throw new Error(`elevenlabs tts ${resp.status}: ${truncate(respText, 240)}`);
  }
  const bytes = Buffer.from(await resp.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error('elevenlabs tts returned zero bytes');
  }
  return {
    bytes,
    providerNote: `elevenlabs/${wireModel} · ${voiceId} · ${bytes.length} bytes`,
    suggestedExt: '.mp3',
  };
}
```

Add the dispatcher branch next to the existing audio providers:

```ts
} else if (def.provider === 'elevenlabs' && surface === 'audio' && ctx.audioKind === 'speech') {
  const result = await renderElevenLabsTTS(ctx, credentials);
  bytes = result.bytes;
  providerNote = result.providerNote;
  suggestedExt = result.suggestedExt;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm --dir apps/daemon exec vitest run -c vitest.config.ts tests/media-elevenlabs.test.ts -t "renders ElevenLabs speech"
```

Expected: PASS with zero failures.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/tests/media-elevenlabs.test.ts apps/daemon/src/media.ts
git commit -m "feat(daemon): add ElevenLabs speech renderer"
```

## Task 2: ElevenLabs sound effects renderer

**Files:**
- Modify: `apps/daemon/tests/media-elevenlabs.test.ts`
- Modify: `apps/daemon/src/media.ts`

- [ ] **Step 1: Write the failing test**

Append a second test to the same file:

```ts
it('renders ElevenLabs sound effects and clamps long durations', async () => {
  await writeConfig({
    providers: {
      elevenlabs: {
        baseUrl: TEST_BASE_URL,
        apiKey: 'eleven-test-key',
      },
    },
  });

  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    expect(String(input)).toBe(`${TEST_BASE_URL}/v1/sound-generation?output_format=mp3_44100_128`);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      'content-type': 'application/json',
      'xi-api-key': 'eleven-test-key',
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      text: 'A cinematic whoosh between sections.',
      duration_seconds: 30,
      prompt_influence: 0.3,
      model_id: 'eleven_text_to_sound_v2',
    });
    return new Response(MP3_BYTES, {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);

  const result = await generateMedia({
    projectRoot,
    projectsRoot,
    projectId: 'project-1',
    surface: 'audio',
    model: 'elevenlabs-sfx',
    prompt: 'A cinematic whoosh between sections.',
    audioKind: 'sfx',
    duration: 120,
    output: 'elevenlabs-sfx.mp3',
  });

  expect(result.providerId).toBe('elevenlabs');
  expect(result.providerNote).toContain('elevenlabs/eleven_text_to_sound_v2');
  expect(result.name).toBe('elevenlabs-sfx.mp3');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir apps/daemon exec vitest run -c vitest.config.ts tests/media-elevenlabs.test.ts -t "sound effects"
```

Expected: FAIL with the current stub-provider path before the renderer exists.

- [ ] **Step 3: Write the minimal implementation**

```ts
const ELEVENLABS_SFX_MODEL_MAP = {
  'elevenlabs-sfx': 'eleven_text_to_sound_v2',
} as Record<string, string>;

function clampElevenLabsSfxDuration(value: unknown): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? value : 5;
  return Math.max(0.5, Math.min(30, raw));
}

async function renderElevenLabsSfx(ctx: MediaContext, credentials: ProviderConfig): Promise<RenderResult> {
  const apiKey = credentials.apiKey?.trim() || '';
  if (!apiKey) {
    throw new Error(
      'no ElevenLabs API key - configure it in Settings or set OD_ELEVENLABS_API_KEY',
    );
  }
  const baseUrl = (credentials.baseUrl || ELEVENLABS_DEFAULT_BASE_URL).replace(/\/$/, '');
  const wireModel = ELEVENLABS_SFX_MODEL_MAP[ctx.model] || ctx.model;
  const text = (ctx.prompt && ctx.prompt.trim()) || 'A short cinematic transition sound.';
  const durationSeconds = clampElevenLabsSfxDuration(ctx.duration);

  const resp = await fetch(`${baseUrl}/v1/sound-generation?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      text,
      duration_seconds: durationSeconds,
      prompt_influence: 0.3,
      model_id: wireModel,
    }),
  });
  const respText = await resp.text();
  if (!resp.ok) {
    throw new Error(`elevenlabs sfx ${resp.status}: ${truncate(respText, 240)}`);
  }
  const bytes = Buffer.from(await resp.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error('elevenlabs sfx returned zero bytes');
  }
  return {
    bytes,
    providerNote: `elevenlabs/${wireModel} · ${durationSeconds}s · ${bytes.length} bytes`,
    suggestedExt: '.mp3',
  };
}
```

Add the dispatcher branch next to the speech branch:

```ts
} else if (def.provider === 'elevenlabs' && surface === 'audio' && ctx.audioKind === 'sfx') {
  const result = await renderElevenLabsSfx(ctx, credentials);
  bytes = result.bytes;
  providerNote = result.providerNote;
  suggestedExt = result.suggestedExt;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm --dir apps/daemon exec vitest run -c vitest.config.ts tests/media-elevenlabs.test.ts -t "sound effects"
```

Expected: PASS with the duration clamped to 30 seconds.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/tests/media-elevenlabs.test.ts apps/daemon/src/media.ts
git commit -m "feat(daemon): add ElevenLabs sound effects renderer"
```

## Task 3: Web provider visibility and registry integration

**Files:**
- Modify: `apps/web/src/media/models.ts`
- Modify: `apps/daemon/src/media-models.ts`
- Modify: `apps/web/src/components/NewProjectPanel.tsx`
- Modify: `apps/web/tests/components/NewProjectPanel.test.ts`
- Modify: `apps/web/tests/components/SettingsDialog.execution.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add the audio visibility coverage to `apps/web/tests/components/NewProjectPanel.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { supportedModels } from '../../src/components/NewProjectPanel';
import { AUDIO_MODELS_BY_KIND, IMAGE_MODELS } from '../../src/media/models';

describe('NewProjectPanel provider visibility', () => {
  it('shows ElevenLabs in supported speech and SFX audio models', () => {
    const speech = supportedModels('audio', AUDIO_MODELS_BY_KIND.speech);
    const sfx = supportedModels('audio', AUDIO_MODELS_BY_KIND.sfx);

    expect(speech.some((model) => model.provider === 'elevenlabs')).toBe(true);
    expect(speech.some((model) => model.id === 'elevenlabs-v3')).toBe(true);
    expect(sfx.some((model) => model.id === 'elevenlabs-sfx')).toBe(true);
  });
});
```

Add the Settings regression to `apps/web/tests/components/SettingsDialog.execution.test.tsx`:

```ts
it('renders ElevenLabs as an integrated media provider row', () => {
  renderSettingsDialog(
    { mode: 'daemon', agentId: 'codex' },
    { initialSection: 'media' },
  );

  const apiKey = screen.getByLabelText('ElevenLabs API key') as HTMLInputElement;
  const baseUrl = screen.getByLabelText('ElevenLabs Base URL') as HTMLInputElement;
  expect(apiKey.disabled).toBe(false);
  expect(baseUrl.disabled).toBe(false);
  const row = apiKey.closest('.media-provider-row');
  expect(row).not.toBeNull();
  expect(within(row as HTMLElement).getByText('Integrated')).toBeTruthy();
  expect(within(row as HTMLElement).queryByText('Unsupported')).toBeNull();
});
```

- [ ] **Step 2: Run test to verify they fail**

Run:

```bash
pnpm --dir apps/web exec vitest run -c vitest.config.ts tests/components/NewProjectPanel.test.ts tests/components/SettingsDialog.execution.test.tsx -t "ElevenLabs"
```

Expected: FAIL because ElevenLabs is still marked unsupported in the registry.

- [ ] **Step 3: Write the minimal implementation**

Update both model registries with the same provider entry:

```ts
{
  id: 'elevenlabs',
  label: 'ElevenLabs',
  hint: 'Voice / SFX',
  integrated: true,
  defaultBaseUrl: 'https://api.elevenlabs.io',
  docsUrl: 'https://elevenlabs.io/app/settings/api-keys',
},
```

Keep the daemon mirror in sync with the same `integrated: true` and `defaultBaseUrl` values.

Then widen the audio provider allow-list in `apps/web/src/components/NewProjectPanel.tsx`:

```ts
audio: new Set(['minimax', 'fishaudio', 'elevenlabs']),
```

The Settings row does not need a special component branch; once `MEDIA_PROVIDERS` marks ElevenLabs integrated, the existing renderer stops disabling the inputs.

- [ ] **Step 4: Run test to verify they pass**

Run:

```bash
pnpm --dir apps/web exec vitest run -c vitest.config.ts tests/components/NewProjectPanel.test.ts tests/components/SettingsDialog.execution.test.tsx -t "ElevenLabs"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/media/models.ts apps/daemon/src/media-models.ts apps/web/src/components/NewProjectPanel.tsx apps/web/tests/components/NewProjectPanel.test.ts apps/web/tests/components/SettingsDialog.execution.test.tsx
git commit -m "feat(web): expose ElevenLabs media providers"
```

## Task 4: Prompt contract and prompt-pinning tests

**Files:**
- Modify: `apps/daemon/src/prompts/media-contract.ts`
- Modify: `apps/daemon/tests/system-prompt-template.test.ts`

- [ ] **Step 1: Write the failing test**

Add an ElevenLabs-specific prompt contract assertion to `apps/daemon/tests/system-prompt-template.test.ts`:

```ts
it('documents ElevenLabs speech and SFX routing in the media contract', () => {
  const out = composeSystemPrompt({
    metadata: {
      kind: 'audio',
      audioKind: 'speech',
      audioModel: 'elevenlabs-v3',
      audioDuration: 10,
      voice: '21m00Tcm4TlvDq8ikWAM',
    },
  });

  expect(out).toContain('`elevenlabs-v3`');
  expect(out).toContain('`elevenlabs-sfx`');
  expect(out).toContain('provider-specific ElevenLabs `voice_id`');
  expect(out).toContain('sound description belongs in `--prompt`');
  expect(out).toContain('SFX duration is capped at 30 seconds');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir apps/daemon exec vitest run -c vitest.config.ts tests/system-prompt-template.test.ts -t "ElevenLabs"
```

Expected: FAIL because the media contract text still describes the old audio guidance.

- [ ] **Step 3: Write the minimal implementation**

Update the media contract text in `apps/daemon/src/prompts/media-contract.ts` so the audio section says:

```md
- `elevenlabs-v3` expects a provider-specific ElevenLabs `voice_id` in `--voice`.
- `elevenlabs-sfx` does not use `--voice`; the sound description belongs in `--prompt`.
- SFX duration is capped at 30 seconds by the provider.
```

Keep the existing `minimax-tts` and `fish-speech-2` guidance intact.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm --dir apps/daemon exec vitest run -c vitest.config.ts tests/system-prompt-template.test.ts -t "ElevenLabs"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/prompts/media-contract.ts apps/daemon/tests/system-prompt-template.test.ts
git commit -m "feat(daemon): document ElevenLabs audio contract"
```

## Task 5: Final validation and cleanup

**Files:**
- Validate the entire touched surface; no new source changes expected unless a failing check exposes a small miss.

- [ ] **Step 1: Run registry drift and focused tests**

Run:

```bash
node scripts/verify-media-models.mjs
pnpm --dir apps/daemon exec vitest run -c vitest.config.ts tests/media-elevenlabs.test.ts tests/system-prompt-template.test.ts
pnpm --dir apps/web exec vitest run -c vitest.config.ts tests/components/NewProjectPanel.test.ts tests/components/SettingsDialog.execution.test.tsx
```

Expected:

- `verify-media-models: OK (TS + JS registries match)`
- all targeted Vitest files pass

- [ ] **Step 2: Run repo-wide safety checks**

Run:

```bash
pnpm guard
pnpm typecheck
```

Expected: both commands exit 0.

- [ ] **Step 3: Review the git diff and commit the feature**

Run:

```bash
git status --short
git diff --stat
```

Then commit the finished feature work with a message that reflects the ElevenLabs audio integration, such as:

```bash
git add apps/daemon/src/media.ts apps/daemon/src/media-models.ts apps/daemon/src/prompts/media-contract.ts apps/daemon/tests/media-elevenlabs.test.ts apps/daemon/tests/system-prompt-template.test.ts apps/web/src/media/models.ts apps/web/src/components/NewProjectPanel.tsx apps/web/tests/components/NewProjectPanel.test.ts apps/web/tests/components/SettingsDialog.execution.test.tsx
git commit -m "feat(audio): add ElevenLabs speech and sfx support"
```
