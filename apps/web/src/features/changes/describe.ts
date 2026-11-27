import type { ChangeView } from '@heph/schema';
import type { MessageKey } from '../../i18n/index.js';

type T = (key: MessageKey, params?: Record<string, string | number>) => string;

/** Change kinds with their own translated text; anything else shows the server's summary. */
const KNOWN = new Set([
  'task/create',
  'task/update',
  'task/move',
  'task/complete',
  'task/reopen',
  'task/delete',
  'phase/create',
  'phase/update',
  'phase/move',
  'phase/delete',
  'project/create',
  'project/update',
  'project/set_status',
  'project/set_next_task',
  'project/test_outcome',
  'material/create',
  'material/update',
  'material/delete',
  'file/create',
  'file/update',
  'file/delete',
  'proposal/create',
  'proposal/approved',
  'proposal/rejected',
  'repo/link',
  'repo/update',
  'repo/unlink',
  'roadmap/restructure',
]);

const FIELDS = new Set([
  'title',
  'notes',
  'link',
  'description',
  'status',
  'name',
  'quantity',
  'unit',
  'price',
  'phaseId',
  'tags',
  'links',
  'slug',
]);

/** One-line, translated description of a change (D74). Pure, for tests. */
export function changeText(c: ChangeView, t: T): string {
  const kind = `${c.entity}/${c.action}`;
  if (!KNOWN.has(kind)) return c.summary;
  const label = c.label ?? (c.entityId !== null ? `#${c.entityId}` : '');
  const fields = c.fields
    .map((f) => (FIELDS.has(f) ? t(`changes.field.${f}` as MessageKey) : f))
    .join(', ');
  if (kind === 'project/set_status' && c.status) {
    return t('changes.project.set_status', {
      from: t(`lifecycle.${c.status.from}` as MessageKey),
      to: t(`lifecycle.${c.status.to}` as MessageKey),
    });
  }
  if (kind === 'project/set_next_task' && c.label === null) {
    return t('changes.project.set_next_task.cleared');
  }
  if (kind === 'roadmap/restructure' && c.operations === 1) {
    return t('changes.roadmap.restructure.one');
  }
  return t(`changes.${c.entity}.${c.action}` as MessageKey, {
    label,
    fields,
    n: c.operations ?? 0,
  });
}

/** Why a revert was refused, from the server's error details (D74). */
export type RevertRefusal =
  | { kind: 'blocked'; blockedBy: number }
  | { kind: 'already' }
  | { kind: 'gone' }
  | { kind: 'not_revertible' }
  | { kind: 'other' };

export function refusalOf(details: unknown): RevertRefusal {
  const d = (details && typeof details === 'object' ? details : {}) as Record<string, unknown>;
  if (d.reason === 'blocked' && typeof d.blockedBy === 'number') {
    return { kind: 'blocked', blockedBy: d.blockedBy };
  }
  if (d.reason === 'already_reverted') return { kind: 'already' };
  if (d.reason === 'gone') return { kind: 'gone' };
  if (d.reason === 'not_revertible') return { kind: 'not_revertible' };
  return { kind: 'other' };
}
