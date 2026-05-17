import type { RoutineRunFailureReason } from './routines.js';

type RunEvent = {
  event?: string;
  data?: unknown;
};

type ErrorPayload = {
  message: string;
  code?: string;
  retryable?: boolean;
};

export function classifyRoutineRunFailureReason(events: RunEvent[]): RoutineRunFailureReason {
  const payload = latestErrorPayload(events) ?? {
    message: 'Routine run failed.',
  };
  return {
    kind: classifyFailureKind(payload),
    message: payload.message,
    ...(payload.code ? { code: payload.code } : {}),
    ...(typeof payload.retryable === 'boolean' ? { retryable: payload.retryable } : {}),
  };
}

function latestErrorPayload(events: RunEvent[]): ErrorPayload | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const record = events[i];
    if (record?.event !== 'error') continue;
    const data = asRecord(record.data);
    const apiError = asRecord(data?.error);
    const message =
      stringValue(apiError?.message) ??
      stringValue(data?.message) ??
      'Routine run failed.';
    const code = stringValue(apiError?.code);
    return {
      message,
      ...(code ? { code } : {}),
      ...(typeof apiError?.retryable === 'boolean' ? { retryable: apiError.retryable } : {}),
    };
  }
  return null;
}

function classifyFailureKind(payload: ErrorPayload): RoutineRunFailureReason['kind'] {
  const text = `${payload.code ?? ''}\n${payload.message}`;
  if (
    payload.code === 'AGENT_AUTH_REQUIRED' ||
    /\b(auth|login|credential|api key|unauthorized|401|CLAUDE_CONFIG_DIR)\b/i.test(text)
  ) {
    return 'agent_auth';
  }
  if (/Agent stalled without emitting any new output/i.test(payload.message)) {
    return 'inactivity_watchdog';
  }
  if (
    payload.code === 'AGENT_UNAVAILABLE' ||
    /\b(spawn failed|not installed|not on PATH|ENOENT|EACCES)\b/i.test(text)
  ) {
    return 'agent_spawn';
  }
  return 'unknown';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
