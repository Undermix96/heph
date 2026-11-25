import { ApiError, NETWORK_ERROR, WRONG_PASSWORD } from '../api/client.js';
import type { MessageKey } from '../i18n/index.js';

/**
 * Fixed, translated text per error code (D44): the UI never shows the server's raw
 * message. Each text says what happened and what to do.
 */
const BY_CODE: Record<string, MessageKey> = {
  not_found: 'error.not_found',
  validation: 'error.validation',
  conflict: 'error.conflict',
  forbidden: 'error.forbidden',
  unauthorized: 'error.unauthorized',
  too_large: 'error.too_large',
  rate_limited: 'error.rate_limited',
  unsupported: 'error.unsupported',
  [NETWORK_ERROR]: 'error.network',
  [WRONG_PASSWORD]: 'settings.wrongPassword',
};

export function errorKey(err: unknown): MessageKey {
  if (err instanceof ApiError) return BY_CODE[err.code] ?? 'error.unknown';
  return 'error.unknown';
}
