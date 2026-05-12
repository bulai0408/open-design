# ElevenLabs Audio Support Design

## Context

Open Design already exposes audio projects through the shared media pipeline:

- The web app lets users create audio projects with `audioKind`, `audioModel`, `audioDuration`, and optional `voice` metadata.
- The daemon dispatches `od media generate --surface audio` through `apps/daemon/src/media.ts`.
- MiniMax and FishAudio already have production TTS renderers.
- ElevenLabs is present in both web and daemon model registries, and `media-config.ts` already supports `OD_ELEVENLABS_API_KEY` / `ELEVENLABS_API_KEY`, but the provider is still marked unsupported and has no renderer branch.

This change makes ElevenLabs production-usable for both registered audio models:

- `elevenlabs-v3` for speech / TTS.
- `elevenlabs-sfx` for sound effects.

## Requirements

1. Mark the existing ElevenLabs provider as integrated in both media model registries.
2. Keep one provider configuration entry: `elevenlabs`.
3. Use the existing credential resolution path:
   - stored Settings config
   - `OD_ELEVENLABS_API_KEY`
   - `ELEVENLABS_API_KEY`
4. Add a default ElevenLabs base URL: `https://api.elevenlabs.io`.
5. Route `audioKind: "speech"` and provider `elevenlabs` to ElevenLabs text-to-speech.
6. Route `audioKind: "sfx"` and provider `elevenlabs` to ElevenLabs text-to-sound-effects.
7. Surface upstream failures with provider-specific error messages.
8. Keep generated outputs as MP3 files.
9. Do not change music generation or add new audio project UI.

## Provider API Mapping

### Speech

Use the ElevenLabs text-to-speech conversion API:

- Method: `POST`
- Path: `/v1/text-to-speech/:voice_id`
- Query: `output_format=mp3_44100_128`
- Auth header: `xi-api-key: <key>`
- JSON body:
  - `text`: trimmed prompt, defaulting to `This is a test.`
  - `model_id`: `eleven_v3` for the registered `elevenlabs-v3` model
  - `voice_settings`: the documented default object
    - `stability: 1`
    - `similarity_boost: 1`
    - `style: 0`
    - `speed: 1`
    - `use_speaker_boost: true`

`ctx.voice` is treated as an ElevenLabs `voice_id`. If omitted, use the common Rachel voice id `21m00Tcm4TlvDq8ikWAM`.

### Sound Effects

Use the ElevenLabs text-to-sound-effects API:

- Method: `POST`
- Path: `/v1/sound-generation`
- Query: `output_format=mp3_44100_128`
- Auth header: `xi-api-key: <key>`
- JSON body:
  - `text`: trimmed prompt, defaulting to `A short cinematic transition sound.`
  - `duration_seconds`: `ctx.duration` clamped to ElevenLabs' 0.5 to 30 second API range
  - `prompt_influence`: `0.3`
  - `model_id`: `eleven_text_to_sound_v2` for the registered `elevenlabs-sfx` model

The existing UI offers 60 and 120 second audio durations. For SFX only, the daemon will clamp those values to 30 seconds instead of sending invalid upstream requests.

## Architecture

### Model Registry

Update both copies of the media registry:

- `apps/web/src/media/models.ts`
- `apps/daemon/src/media-models.ts`

The ElevenLabs provider becomes:

- `integrated: true`
- `defaultBaseUrl: "https://api.elevenlabs.io"`

The registered model ids remain unchanged:

- `elevenlabs-v3`
- `elevenlabs-sfx`

Keeping stable ids avoids migration work for existing project metadata and keeps `scripts/verify-media-models.mjs` focused on drift detection.

### Web UI

Update `supportedModels()` in `apps/web/src/components/NewProjectPanel.tsx` so audio models from provider `elevenlabs` are visible in the Audio model cards once the provider is integrated.

Settings needs no custom component changes because it renders from `MEDIA_PROVIDERS`. Once the provider is integrated, its row becomes editable and no longer disabled.

### Daemon Dispatcher

Add two provider renderers to `apps/daemon/src/media.ts`:

- `renderElevenLabsTTS(ctx, credentials)`
- `renderElevenLabsSfx(ctx, credentials)`

Add a dispatcher branch after FishAudio / MiniMax style audio branches:

- `def.provider === "elevenlabs" && surface === "audio" && ctx.audioKind === "speech"`
- `def.provider === "elevenlabs" && surface === "audio" && ctx.audioKind === "sfx"`

The renderer should throw clear errors for:

- missing API key
- non-OK upstream response
- zero-byte response

Error messages should follow the existing provider style:

- `no ElevenLabs API key - configure it in Settings or set OD_ELEVENLABS_API_KEY`
- `elevenlabs tts <status>: <truncated body>`
- `elevenlabs sfx <status>: <truncated body>`

### Prompt Contract

Update `apps/daemon/src/prompts/media-contract.ts` so agents know:

- `elevenlabs-v3` expects a provider-specific ElevenLabs `voice_id` in `--voice`.
- `elevenlabs-sfx` does not use `--voice`; the sound description belongs in `--prompt`.
- SFX duration is capped at 30 seconds by the provider.

## Testing Plan

Use TDD. Add failing tests before implementation.

Daemon tests:

1. `generateMedia()` with `model: "elevenlabs-v3"` and `audioKind: "speech"`:
   - stubs `fetch`
   - asserts the URL includes `/v1/text-to-speech/<voice_id>?output_format=mp3_44100_128`
   - asserts `xi-api-key`
   - asserts body includes `text` and `model_id: "eleven_v3"`
   - asserts MP3 bytes are written
2. `generateMedia()` with `model: "elevenlabs-sfx"` and `audioKind: "sfx"`:
   - stubs `fetch`
   - asserts URL `/v1/sound-generation`
   - asserts body includes `text`, `duration_seconds`, `prompt_influence`, and `model_id: "eleven_text_to_sound_v2"`
   - asserts durations above 30 are clamped to 30
3. Upstream error propagation for one ElevenLabs path:
   - returns non-OK response
   - expects the provider-specific error prefix

Web tests:

1. `supportedModels("audio", AUDIO_MODELS_BY_KIND.speech)` includes `elevenlabs-v3`.
2. `supportedModels("audio", AUDIO_MODELS_BY_KIND.sfx)` includes `elevenlabs-sfx`.
3. Settings provider rows no longer render ElevenLabs as unsupported.

Registry drift:

- `node scripts/verify-media-models.mjs`

Validation after implementation:

- Focused daemon Vitest file for ElevenLabs media generation.
- Focused web Vitest files for model visibility and Settings media provider rendering.
- `node scripts/verify-media-models.mjs`
- `pnpm guard`
- `pnpm typecheck`

## Non-Goals

- Do not implement ElevenLabs conversational AI.
- Do not implement voice listing or voice cloning management.
- Do not add a new UI for selecting ElevenLabs voices.
- Do not make ElevenLabs the default speech or SFX model.
- Do not change OpenAI, MiniMax, FishAudio, music, video, or image dispatch behavior.

## Risks and Mitigations

- Risk: The registered id `elevenlabs-v3` does not exactly match the upstream wire id.
  - Mitigation: map registry id to `eleven_v3` inside the ElevenLabs renderer, matching the existing MiniMax and FishAudio model-map pattern.
- Risk: SFX UI durations include values ElevenLabs rejects.
  - Mitigation: clamp SFX `duration_seconds` to 30 seconds in the daemon.
- Risk: Natural-language `voice` strings get sent as invalid ElevenLabs voice ids.
  - Mitigation: document the requirement in the prompt contract. The daemon will treat `voice` as a raw provider id, consistent with MiniMax and FishAudio.
- Risk: Registry drift between web and daemon copies.
  - Mitigation: run `scripts/verify-media-models.mjs`.
