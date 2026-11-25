import { MATERIAL_STATUSES, type MaterialStatus, type MaterialView } from '@heph/schema';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api } from '../../api/client.js';
import { useApiMutation } from '../../api/queries.js';
import {
  Alert,
  Box,
  Button,
  Dialog,
  EmptyState,
  Menu,
  Segmented,
  Skeleton,
} from '../../components/ui.js';
import { type MessageKey, useI18n, useT } from '../../i18n/index.js';
import { errorKey } from '../../lib/errors.js';

type Filter = 'all' | MaterialStatus;

/** Totals per status and overall cost (price × quantity); pure for tests. */
export function materialTotals(items: MaterialView[]) {
  const byStatus = Object.fromEntries(MATERIAL_STATUSES.map((s) => [s, 0])) as Record<
    MaterialStatus,
    number
  >;
  let cost = 0;
  let toSpend = 0;
  for (const m of items) {
    byStatus[m.status] += 1;
    const line = (m.price ?? 0) * m.quantity;
    cost += line;
    if (m.status === 'to_buy') toSpend += line;
  }
  return { byStatus, cost: Math.round(cost * 100) / 100, toSpend: Math.round(toSpend * 100) / 100 };
}

/** Materials (mockup 14): status filter, totals, inline status, quick add. No CSV (D50). */
export function MaterialsTab({ projectRef }: { projectRef: string }) {
  const t = useT();
  const { lang } = useI18n();
  const key = ['materials', projectRef];
  const q = useQuery({ queryKey: key, queryFn: () => api.materials(projectRef) });
  const [filter, setFilter] = useState<Filter>('all');
  const [confirm, setConfirm] = useState<MaterialView | null>(null);
  const update = useApiMutation(
    (a: { id: number; status: MaterialStatus }) => api.updateMaterial(a.id, { status: a.status }),
    { invalidate: () => [key] },
  );
  const del = useApiMutation((id: number) => api.deleteMaterial(id), {
    invalidate: () => [key],
    onSuccess: () => setConfirm(null),
  });

  if (q.isPending) return <Skeleton lines={5} />;
  if (q.isError) {
    return (
      <Alert
        tone="danger"
        action={<Button onClick={() => q.refetch()}>{t('common.retry')}</Button>}
      >
        {t(errorKey(q.error))}
      </Alert>
    );
  }
  const items = q.data;
  const totals = materialTotals(items);
  const currency = items[0]?.currency;
  const money = (n: number) =>
    currency
      ? new Intl.NumberFormat(lang, { style: 'currency', currency }).format(n)
      : new Intl.NumberFormat(lang).format(n);
  const shown = filter === 'all' ? items : items.filter((m) => m.status === filter);

  return (
    <div className="stack">
      <div className="totals">
        {MATERIAL_STATUSES.map((s) => (
          <Box key={s}>
            <div className="total-n">{totals.byStatus[s]}</div>
            <div className="meta">{t(`material.${s}` as MessageKey)}</div>
          </Box>
        ))}
        <Box>
          <div className="total-n">{money(totals.cost)}</div>
          <div className="meta">
            {t('materials.cost')} · {t('materials.toSpend', { amount: money(totals.toSpend) })}
          </div>
        </Box>
      </div>
      <Segmented<Filter>
        label={t('materials.filter')}
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: t('diary.all') },
          ...MATERIAL_STATUSES.map((s) => ({ value: s, label: t(`material.${s}` as MessageKey) })),
        ]}
      />
      <Box>
        {items.length === 0 ? (
          <EmptyState title={t('materials.empty.title')} text={t('materials.empty.text')} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{t('materials.name')}</th>
                  <th scope="col">{t('materials.quantity')}</th>
                  <th scope="col">{t('materials.price')}</th>
                  <th scope="col">{t('materials.status')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('materials.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((m) => (
                  <tr key={m.id}>
                    <td className="truncate" title={m.name}>
                      {m.link ? (
                        <a href={m.link} target="_blank" rel="noreferrer noopener">
                          {m.name}
                        </a>
                      ) : (
                        m.name
                      )}
                    </td>
                    <td>
                      {m.quantity}
                      {m.unit ? ` ${m.unit}` : ''}
                    </td>
                    <td>{m.price === null ? '—' : money(m.price)}</td>
                    <td>
                      <label className="sr-only" htmlFor={`ms-${m.id}`}>
                        {t('materials.statusOf', { name: m.name })}
                      </label>
                      <select
                        id={`ms-${m.id}`}
                        value={m.status}
                        onChange={(e) =>
                          update.mutate({ id: m.id, status: e.target.value as MaterialStatus })
                        }
                      >
                        {MATERIAL_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {t(`material.${s}` as MessageKey)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <Menu
                        label={t('materials.menu', { name: m.name })}
                        items={[
                          {
                            label: t('roadmap.delete'),
                            danger: true,
                            onSelect: () => setConfirm(m),
                          },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <QuickAdd projectRef={projectRef} onAdded={() => q.refetch()} />
      </Box>
      {confirm && (
        <Dialog
          title={t('materials.deleteTitle')}
          onClose={() => setConfirm(null)}
          actions={
            <>
              <Button onClick={() => setConfirm(null)}>{t('common.cancel')}</Button>
              <Button
                variant="danger"
                disabled={del.isPending}
                onClick={() => del.mutate(confirm.id)}
              >
                {t('roadmap.delete')}
              </Button>
            </>
          }
        >
          <p>{t('materials.deleteText', { name: confirm.name })}</p>
        </Dialog>
      )}
    </div>
  );
}

function QuickAdd({ projectRef, onAdded }: { projectRef: string; onAdded: () => void }) {
  const t = useT();
  const [name, setName] = useState('');
  const [qty, setQty] = useState('1');
  const [unit, setUnit] = useState('');
  const [price, setPrice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = useApiMutation(
    (input: Parameters<typeof api.addMaterial>[1]) => api.addMaterial(projectRef, input),
    {
      onSuccess: () => {
        setName('');
        setQty('1');
        setUnit('');
        setPrice('');
        onAdded();
      },
    },
  );
  // Decimal comma or point, as people type it.
  const num = (s: string) => Number(s.trim().replace(',', '.'));
  function submit(e: FormEvent) {
    e.preventDefault();
    const quantity = num(qty);
    const p = price.trim() ? num(price) : null;
    if (!name.trim()) return setError(t('materials.nameRequired'));
    if (!(quantity > 0) || (p !== null && !(p >= 0))) return setError(t('materials.badNumber'));
    setError(null);
    add.mutate({ name: name.trim(), quantity, unit: unit.trim() || null, price: p });
  }
  return (
    <form className="row quick-add" onSubmit={submit} noValidate>
      <label className="sr-only" htmlFor="qa-name">
        {t('materials.name')}
      </label>
      <input
        id="qa-name"
        placeholder={t('materials.name')}
        value={name}
        maxLength={300}
        onChange={(e) => setName(e.target.value)}
      />
      <label className="sr-only" htmlFor="qa-qty">
        {t('materials.quantity')}
      </label>
      <input
        id="qa-qty"
        inputMode="decimal"
        className="w-num"
        value={qty}
        onChange={(e) => setQty(e.target.value)}
      />
      <label className="sr-only" htmlFor="qa-unit">
        {t('materials.unit')}
      </label>
      <input
        id="qa-unit"
        placeholder={t('materials.unit')}
        className="w-num"
        value={unit}
        maxLength={30}
        onChange={(e) => setUnit(e.target.value)}
      />
      <label className="sr-only" htmlFor="qa-price">
        {t('materials.price')}
      </label>
      <input
        id="qa-price"
        inputMode="decimal"
        placeholder={t('materials.price')}
        className="w-num"
        value={price}
        onChange={(e) => setPrice(e.target.value)}
      />
      <Button type="submit" size="sm" disabled={add.isPending}>
        {t('roadmap.add')}
      </Button>
      {error && (
        <p className="hint error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
