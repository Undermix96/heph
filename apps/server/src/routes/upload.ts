import type { Domain } from '@heph/core';
import { Hono } from 'hono';
import type { AppEnv } from '../http/common.js';

/** One-time agent uploads: POST /upload/:token (multipart, field "file"). */
export function uploadRoutes(_domain: Domain) {
  return new Hono<AppEnv>();
}
