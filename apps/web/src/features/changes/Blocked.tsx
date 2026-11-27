import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.js';
import { useT } from '../../i18n/index.js';
import { changeText } from './describe.js';

/**
 * Why a revert is blocked (D74, D77): the later change that touched the same item,
 * and what to do — revert it first, or, when it cannot be reverted, nothing more
 * can be done for this change (verification B9).
 */
export function BlockedText({
  blockedBy,
  where,
}: {
  blockedBy: number;
  where: 'changes' | 'proposal';
}) {
  const t = useT();
  const q = useQuery({ queryKey: ['change', blockedBy], queryFn: () => api.change(blockedBy) });
  const what = q.data ? changeText(q.data, t) : `#${blockedBy}`;
  // Until the later change is read, assume it can be reverted (the common case).
  const final = q.data ? !q.data.revertible : false;
  const key =
    where === 'changes'
      ? final
        ? 'changes.error.blockedFinal'
        : 'changes.error.blocked'
      : final
        ? 'proposals.error.blockedFinal'
        : 'proposals.error.blocked';
  return <>{t(key, { id: blockedBy, what })}</>;
}
