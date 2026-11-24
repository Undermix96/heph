import { type FormEvent, StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError, api, type User } from './api';
import { detectLang, type Strings, strings } from './i18n/strings';
import './styles/tokens.css';
import './styles/auth.css';

/**
 * Phase 1–2 web UI: only what is needed to exercise the setup and login flows.
 * The full UI (phase 4) replaces this.
 */
type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'setup' }
  | { kind: 'login' }
  | { kind: 'home'; user: User; apiToken?: string };

function App() {
  const t = strings[detectLang()];
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    api
      .status()
      .then((s) =>
        setState(
          s.user ? { kind: 'home', user: s.user } : { kind: s.setupDone ? 'login' : 'setup' },
        ),
      )
      .catch(() => setState({ kind: 'error', message: t.unreachable }));
  }, [t]);

  switch (state.kind) {
    case 'loading':
      return <Shell title={t.loading} />;
    case 'error':
      return (
        <Shell title="Hephaestus">
          <div className="alert">{state.message}</div>
        </Shell>
      );
    case 'setup':
      return (
        <CredentialsForm
          t={t}
          mode="setup"
          onDone={(user, apiToken) => setState({ kind: 'home', user, apiToken })}
        />
      );
    case 'login':
      return (
        <CredentialsForm t={t} mode="login" onDone={(user) => setState({ kind: 'home', user })} />
      );
    case 'home':
      return (
        <Shell title="Hephaestus">
          <div className="panel">
            <p>
              {t.welcome} <strong>{state.user.username}</strong>
            </p>
            {state.apiToken && (
              <>
                <p>
                  <strong>{t.apiTokenTitle}</strong>
                </p>
                <div className="token">{state.apiToken}</div>
                <p className="muted">{t.apiTokenHint}</p>
              </>
            )}
            <p className="muted">{t.wip}</p>
            <button
              type="button"
              className="btn"
              onClick={() => api.logout().then(() => setState({ kind: 'login' }))}
            >
              {t.signOut}
            </button>
          </div>
        </Shell>
      );
  }
}

function Shell({ title, children }: { title: string; children?: React.ReactNode }) {
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

function CredentialsForm({
  t,
  mode,
  onDone,
}: {
  t: Strings;
  mode: 'setup' | 'login';
  onDone: (user: User, apiToken?: string) => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === 'setup' && password !== confirm) {
      setError(t.passwordMismatch);
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
      setError(err instanceof ApiError ? err.message : t.unreachable);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell title={mode === 'setup' ? t.setupTitle : t.loginTitle}>
      {mode === 'setup' && <p className="intro">{t.setupIntro}</p>}
      <form className="panel" onSubmit={submit}>
        {error && (
          <div className="alert" role="alert">
            {error}
          </div>
        )}
        <div className="field">
          <label htmlFor="username">{t.username}</label>
          <input
            id="username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password">{t.password}</label>
          <input
            id="password"
            type="password"
            autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={mode === 'setup' ? 8 : undefined}
          />
        </div>
        {mode === 'setup' && (
          <div className="field">
            <label htmlFor="confirm">{t.passwordConfirm}</label>
            <input
              id="confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </div>
        )}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {mode === 'setup' ? t.createUser : t.signIn}
        </button>
      </form>
    </Shell>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
