import type { Settings } from '@heph/schema';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { api } from '../../api/client.js';
import { keys, useApiMutation } from '../../api/queries.js';
import { useNotices } from '../../app/notices.js';
import { Alert, Box, Button, Dialog, Field, Skeleton } from '../../components/ui.js';
import { type MessageKey, useT } from '../../i18n/index.js';
import { errorKey } from '../../lib/errors.js';
import { ConnectBox } from './ConnectBox.js';
import { TestPatterns } from './TestPatterns.js';

/** Settings (mockup 31): account, language, Connect Claude Code (D60), thresholds, tests. */
export function SettingsPage() {
  const t = useT();
  const q = useQuery({ queryKey: keys.settings, queryFn: api.settings, refetchInterval: false });
  const { hash } = useLocation();
  // Links such as /settings#s-claude: scroll once the sections are rendered.
  useEffect(() => {
    if (hash && q.data) document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [hash, q.data]);
  return (
    <main className="page narrow">
      <h1 className="page-title">{t('nav.settings')}</h1>
      <nav className="settings-nav" aria-label={t('nav.settings')}>
        {(
          [
            'account',
            'language',
            'claude',
            'github',
            'activity',
            'tests',
            'files',
            'other',
          ] as const
        ).map((s) => (
          <a key={s} href={`#s-${s}`}>
            {t(`settings.${s}` as MessageKey)}
          </a>
        ))}
      </nav>
      {q.isPending ? (
        <Skeleton lines={8} />
      ) : q.isError ? (
        <Alert
          tone="danger"
          action={<Button onClick={() => q.refetch()}>{t('common.retry')}</Button>}
        >
          {t(errorKey(q.error))}
        </Alert>
      ) : (
        <div className="stack">
          <PasswordBox />
          <ConnectBox />
          <SettingsForm settings={q.data} />
        </div>
      )}
    </main>
  );
}

function PasswordBox() {
  const t = useT();
  const notices = useNotices();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<MessageKey | null>(null);
  const change = useApiMutation(() => api.changePassword(current, next), {
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setRepeat('');
      notices.info('settings.passwordChanged');
    },
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== repeat) return setError('auth.passwordMismatch');
    if (next.length < 8) return setError('settings.passwordShort');
    setError(null);
    change.mutate(undefined);
  }
  return (
    <section id="s-account">
      <Box title={t('settings.account')}>
        <form onSubmit={submit} noValidate>
          <Field label={t('settings.currentPassword')} htmlFor="pw-cur">
            <input
              id="pw-cur"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <Field
            label={t('settings.newPassword')}
            htmlFor="pw-new"
            hint={t('settings.passwordHint')}
          >
            <input
              id="pw-new"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </Field>
          <Field label={t('auth.passwordConfirm')} htmlFor="pw-rep" error={error ? t(error) : null}>
            <input
              id="pw-rep"
              type="password"
              autoComplete="new-password"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
            />
          </Field>
          <Button type="submit" disabled={!current || !next || change.isPending}>
            {t('settings.changePassword')}
          </Button>
        </form>
      </Box>
    </section>
  );
}

type NumKey =
  | 'recentlyActiveDays'
  | 'inactiveDays'
  | 'sessionExpiryMinutes'
  | 'diaryNudgeTurns'
  | 'diaryNudgeMinutes'
  | 'screenshotRetentionPerTarget'
  | 'maxUploadMb'
  | 'githubPollMinutes';

function SettingsForm({ settings }: { settings: Settings }) {
  const t = useT();
  const qc = useQueryClient();
  const notices = useNotices();
  const [s, setS] = useState(settings);
  const [github, setGithub] = useState('');
  const [error, setError] = useState<MessageKey | null>(null);
  const save = useApiMutation((patch: Partial<Settings>) => api.updateSettings(patch), {
    onSuccess: (r) => {
      qc.setQueryData(keys.settings, r);
      setS(r);
      setGithub('');
      notices.info('settings.saved');
    },
  });
  const num = (k: NumKey, label: MessageKey, hint?: MessageKey) => (
    <Field label={t(label)} htmlFor={`set-${k}`} hint={hint ? t(hint) : undefined}>
      <input
        id={`set-${k}`}
        type="number"
        min={1}
        value={s[k]}
        onChange={(e) => setS({ ...s, [k]: Number(e.target.value) })}
      />
    </Field>
  );
  function submit(e: FormEvent) {
    e.preventDefault();
    if (s.recentlyActiveDays >= s.inactiveDays) return setError('settings.thresholdOrder');
    if (!/^[A-Za-z]{3}$/.test(s.currency)) return setError('settings.badCurrency');
    setError(null);
    const { githubToken: _g, ...rest } = s;
    save.mutate({ ...rest, ...(github.trim() ? { githubToken: github.trim() } : {}) });
  }
  return (
    <form className="stack" onSubmit={submit} noValidate>
      <section id="s-language">
        <Box title={t('settings.language')}>
          <Field label={t('settings.uiLanguage')} htmlFor="set-ui">
            <select
              id="set-ui"
              value={s.uiLanguage}
              onChange={(e) => setS({ ...s, uiLanguage: e.target.value as Settings['uiLanguage'] })}
            >
              <option value="it">Italiano</option>
              <option value="en">English</option>
            </select>
          </Field>
          <Field
            label={t('settings.contentLanguage')}
            htmlFor="set-content"
            hint={t('settings.contentLanguageHint')}
          >
            <select
              id="set-content"
              value={s.contentLanguage}
              onChange={(e) =>
                setS({ ...s, contentLanguage: e.target.value as Settings['contentLanguage'] })
              }
            >
              <option value="it">Italiano</option>
              <option value="en">English</option>
            </select>
          </Field>
        </Box>
      </section>
      <section id="s-github">
        <Box title={t('settings.github')}>
          <p className="meta">
            {t(settings.githubToken ? 'settings.githubSet' : 'settings.githubNotSet')}
          </p>
          <Field label={t('settings.githubToken')} htmlFor="set-gh" hint={t('settings.githubHint')}>
            <input
              id="set-gh"
              type="password"
              autoComplete="off"
              value={github}
              onChange={(e) => setGithub(e.target.value)}
            />
          </Field>
          {num('githubPollMinutes', 'settings.githubPoll')}
        </Box>
      </section>
      <section id="s-activity">
        <Box title={t('settings.activity')}>
          {num('recentlyActiveDays', 'settings.recentDays')}
          {num('inactiveDays', 'settings.inactiveDays')}
          {num('sessionExpiryMinutes', 'settings.sessionExpiry')}
          {num('diaryNudgeTurns', 'settings.diaryTurns', 'settings.diaryHint')}
          {num('diaryNudgeMinutes', 'settings.diaryMinutes')}
        </Box>
      </section>
      <section id="s-tests">
        <Box title={t('settings.tests')}>
          <p className="muted">{t('connect.patternsIntro')}</p>
          <TestPatterns
            value={s.testCommandPatterns}
            onChange={(testCommandPatterns) => setS({ ...s, testCommandPatterns })}
          />
        </Box>
      </section>
      <section id="s-files">
        <Box title={t('settings.files')}>
          {num('screenshotRetentionPerTarget', 'settings.retention', 'settings.retentionHint')}
          {num('maxUploadMb', 'settings.maxUpload')}
        </Box>
      </section>
      <section id="s-other">
        <Box title={t('settings.other')}>
          <Field label={t('settings.currency')} htmlFor="set-cur" hint={t('settings.currencyHint')}>
            <input
              id="set-cur"
              value={s.currency}
              maxLength={3}
              onChange={(e) => setS({ ...s, currency: e.target.value.toUpperCase() })}
            />
          </Field>
          <label className="check">
            <input
              type="checkbox"
              checked={s.allowClaudeConfirm}
              onChange={(e) => setS({ ...s, allowClaudeConfirm: e.target.checked })}
            />
            {t('settings.allowConfirm')}
          </label>
          <p className="hint">{t('settings.allowConfirmHint')}</p>
        </Box>
      </section>
      {error && <Alert tone="danger">{t(error)}</Alert>}
      <div>
        <Button type="submit" variant="primary" disabled={save.isPending}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}
