import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ArtifactPublicationBlockedError,
  findUnresolvedArtifactPlaceholders,
  shouldBlockArtifactPublication,
} from '../src/artifact-publication-guard.js';
import { listFiles, writeProjectFile } from '../src/projects.js';

const deckManifest = {
  kind: 'deck',
  renderer: 'deck-html',
  title: 'Pitch deck',
  exports: ['html', 'pdf'],
  metadata: { identifier: 'pitch-deck' },
};

describe('artifact publication guard', () => {
  it('detects unresolved pitch-deck placeholders from generated HTML', () => {
    const html = `
      <!doctype html>
      <html>
        <body>
          <section>Name to confirm</section>
          <section>$X.XM</section>
          <section>Replace this panel with actual pipeline once known.</section>
          <section>Replace role placeholders with leadership names.</section>
          <section>Your form answer only said "seed deck".</section>
        </body>
      </html>
    `;

    expect(findUnresolvedArtifactPlaceholders(html)).toEqual([
      'Name to confirm',
      '$X.XM',
      'Replace this panel with',
      'Replace role placeholders',
      'Your form answer only said',
    ]);
    expect(shouldBlockArtifactPublication(html)).toBe(true);
  });

  it('allows real pitch-deck content with concrete ask and traction data', () => {
    const html = `
      <!doctype html>
      <html>
        <body>
          <section>Acme AI turns support transcripts into shipped product fixes.</section>
          <section>$4.5M seed round</section>
          <section>42% MoM revenue growth, 18 enterprise pilots, 91% retention.</section>
          <section>Use of funds: engineering, GTM, compliance, and customer success.</section>
        </body>
      </html>
    `;

    expect(findUnresolvedArtifactPlaceholders(html)).toEqual([]);
    expect(shouldBlockArtifactPublication(html)).toBe(false);
  });

  it('rejects published HTML artifacts that still contain pitch-deck placeholders', async () => {
    const projectsRoot = await mkdtemp(path.join(tmpdir(), 'od-publication-guard-'));
    try {
      await expect(
        writeProjectFile(
          projectsRoot,
          'project-1',
          'pitch-deck.html',
          Buffer.from('<html><body><section>Name to confirm</section><section>$X.XM</section></body></html>'),
          { artifactManifest: deckManifest } as unknown as Parameters<typeof writeProjectFile>[4],
        ),
      ).rejects.toBeInstanceOf(ArtifactPublicationBlockedError);

      const files = await listFiles(projectsRoot, 'project-1');
      expect(files.map((file) => file.name)).not.toContain('pitch-deck.html');
      expect(files.map((file) => file.name)).not.toContain('pitch-deck.html.artifact.json');
    } finally {
      await rm(projectsRoot, { recursive: true, force: true });
    }
  });
});
