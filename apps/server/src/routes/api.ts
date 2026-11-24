import type { Domain } from '@heph/core';
import { Hono } from 'hono';
import type { AppEnv } from '../http/common.js';

/** REST API routes; the caller has already been authenticated. */
export function apiRoutes(_domain: Domain) {
  return new Hono<AppEnv>();
}
