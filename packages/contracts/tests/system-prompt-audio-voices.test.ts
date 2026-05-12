import { describe, expect, it } from 'vitest';

import { composeSystemPrompt } from '../src/prompts/system.js';

describe('composeSystemPrompt — audio voice options', () => {
  it('renders an ElevenLabs voice select form in API-mode project metadata', () => {
    const prompt = composeSystemPrompt({
      streamFormat: 'plain',
      metadata: {
        kind: 'audio',
        audioKind: 'speech',
        audioModel: 'elevenlabs-v3',
        audioDuration: 10,
      },
      audioVoiceOptions: [
        {
          name: 'Rachel',
          voiceId: '21m00Tcm4TlvDq8ikWAM',
          category: 'premade',
          labels: { accent: 'american', gender: 'female' },
        },
      ],
    });

    expect(prompt).toContain('<question-form id="elevenlabs-voice" title="Choose an ElevenLabs voice">');
    expect(prompt).toContain('"type": "select"');
    expect(prompt).toContain('"label": "Rachel — american · female"');
    expect(prompt).toContain('"value": "21m00Tcm4TlvDq8ikWAM"');
    expect(prompt).toContain('selected value must be the exact `voice_id`');
  });
});
