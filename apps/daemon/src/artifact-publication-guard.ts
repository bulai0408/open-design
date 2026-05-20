import { Buffer } from 'node:buffer';

export const ARTIFACT_PUBLICATION_BLOCKED_CODE = 'ARTIFACT_PUBLICATION_BLOCKED' as const;

export const PUBLICATION_GUARDED_ARTIFACT_KINDS: ReadonlySet<string> = new Set(['html', 'deck']);

export const UNRESOLVED_ARTIFACT_PLACEHOLDERS = [
  'Name to confirm',
  '$X.XM',
  'Replace this panel with',
  'Replace role placeholders',
  'Your form answer only said',
] as const;

export class ArtifactPublicationBlockedError extends Error {
  readonly code = ARTIFACT_PUBLICATION_BLOCKED_CODE;
  readonly placeholders: string[];

  constructor(placeholders: string[]) {
    super(buildArtifactPublicationBlockedMessage(placeholders));
    this.name = 'ArtifactPublicationBlockedError';
    this.placeholders = [...placeholders];
  }
}

export function isPublicationGuardedArtifactKind(kind: unknown): boolean {
  return typeof kind === 'string' && PUBLICATION_GUARDED_ARTIFACT_KINDS.has(kind);
}

export function findUnresolvedArtifactPlaceholders(value: unknown): string[] {
  const text = stringifyArtifactContent(value);
  if (!text) return [];
  return UNRESOLVED_ARTIFACT_PLACEHOLDERS.filter((placeholder) =>
    text.includes(placeholder),
  );
}

export function shouldBlockArtifactPublication(value: unknown): boolean {
  return findUnresolvedArtifactPlaceholders(value).length > 0;
}

export function buildArtifactPublicationBlockedMessage(placeholders: readonly string[]): string {
  const list = placeholders.length > 0 ? placeholders.join(', ') : 'unknown placeholders';
  return `Artifact still contains unresolved pitch-deck placeholders: ${list}. Provide the required pitch facts before publishing.`;
}

export function assertArtifactPublicationAllowed(value: unknown): void {
  const placeholders = findUnresolvedArtifactPlaceholders(value);
  if (placeholders.length > 0) {
    throw new ArtifactPublicationBlockedError(placeholders);
  }
}

function stringifyArtifactContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  return '';
}
