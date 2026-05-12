import type { AudioVoiceOption } from '@open-design/contracts';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object';
}

function readString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function readLabels(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const labels: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const normalized = readString(raw);
    if (normalized) labels[key] = normalized;
  }
  return Object.keys(labels).length > 0 ? labels : undefined;
}

function normalizeVoice(value: unknown): AudioVoiceOption | null {
  if (!isRecord(value)) return null;
  const voiceId = readString(value.voiceId);
  const name = readString(value.name);
  if (!voiceId || !name) return null;
  const category = readString(value.category);
  const labels = readLabels(value.labels);
  return {
    voiceId,
    name,
    ...(category ? { category } : {}),
    ...(labels ? { labels } : {}),
  };
}

export async function fetchElevenLabsVoiceOptions(
  signal?: AbortSignal,
): Promise<AudioVoiceOption[]> {
  const response = await fetch('/api/media/providers/elevenlabs/voices?limit=12', {
    signal,
  });
  if (!response.ok) return [];
  const payload = await response.json() as unknown;
  const rawVoices = isRecord(payload) && Array.isArray(payload.voices)
    ? payload.voices
    : [];
  return rawVoices
    .map((voice) => normalizeVoice(voice))
    .filter((voice): voice is AudioVoiceOption => voice !== null);
}
