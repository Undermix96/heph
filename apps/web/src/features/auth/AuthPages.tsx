import { type FormEvent, type ReactNode, useState } from 'react';
import { api, type User } from '../../api/client.js';
import { Alert, Button, Field } from '../../components/ui.js';
import { useT } from '../../i18n/index.js';
import { errorKey } from '../../lib/errors.js';

export function AuthShell({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <main className="auth">
      <div className="auth-box">
        <div className="auth-logo" aria-hidden="true">
          H
        </div>
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}

/** First run (mockup 40) and sign-in (mockup 41). */
export function CredentialsForm({
  mode,
  onDone,
}: {
  mode: 'setup' | 'login';
  onDone: (user: User, apiToken?: string) => void;
}) {
  const t = useT();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === 'setup' && password !== confirm) {
      setError(t('auth.passwordMismatch'));
      return;
    }
    setBusy(true);
    try {
      if (mode === 'setup') {
        const r = await api.setup(username, password);
        onDone(r.user, r.apiToken);
      } else {
        const r = await api.login(username, password);
        onDone(r.user);
      }
    } catch (err) {
      setError(
        t(
          mode === 'login' && errorKey(err) === 'error.unauthorized'
            ? 'auth.badCredentials'
            : errorKey(err),
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title={t(mode === 'setup' ? 'auth.setupTitle' : 'auth.loginTitle')}>
      {mode === 'setup' && <p className="intro">{t('auth.setupIntro')}</p>}
      <form className="panel" onSubmit={submit}>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label={t('auth.username')} htmlFor="username">
          <input
            id="username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </Field>
        <Field label={t('auth.password')} htmlFor="password">
          <input
            id="password"
            type="password"
            autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={mode === 'setup' ? 8 : undefined}
          />
        </Field>
        {mode === 'setup' && (
          <Field label={t('auth.passwordConfirm')} htmlFor="confirm">
            <input
              id="confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </Field>
        )}
        <Button type="submit" variant="primary" disabled={busy} className="btn-block">
          {t(mode === 'setup' ? 'auth.createUser' : 'auth.signIn')}
        </Button>
      </form>
    </AuthShell>
  );
}

/** Shown once after first run: the API token, which is also in Settings (D45). */
export function TokenNotice({ token, onContinue }: { token: string; onContinue: () => void }) {
  const t = useT();
  return (
    <AuthShell title={t('auth.apiTokenTitle')}>
      <div className="panel">
        <p>{t('auth.apiTokenHint')}</p>
        <div className="token">{token}</div>
        <Button variant="primary" className="btn-block" onClick={onContinue}>
          {t('common.continue')}
        </Button>
      </div>
    </AuthShell>
  );
}
