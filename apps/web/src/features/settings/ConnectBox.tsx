import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client.js';
import { useApiMutation } from '../../api/queries.js';
import { useNotices } from '../../app/notices.js';
import { Box, Button, Dialog, RelativeTime } from '../../components/ui.js';
import { useT } from '../../i18n/index.js';

/** Where the plugin is published (D57: marketplace in this repo). */
const MARKETPLACE = 'Undermix96/heph';
const PLUGIN = 'heph@heph';

/** A call within this window counts as "connected" in the status pill. */
const CONNECTED_MS = 60 * 60_000;

/**
 * "Connect Claude Code" (§4, mockup 31, D60): the exact steps to install and
 * configure the plugin, with this server's agent URL and the API token
 * (readable here, D45). The design's step "Heph project in CLAUDE.md" is
 * replaced by linking the repo to its project (spec wins, D23).
 */
export function ConnectBox() {
  const t = useT();
  const connect = useQuery({ queryKey: ['settings', 'connect'], queryFn: api.connect });
  const last = connect.data?.lastAgentCallAt ?? null;
  const recent = last !== null && Date.now() - Date.parse(last) < CONNECTED_MS;
  return (
    <section id="s-claude">
      <Box
        title={t('settings.claude')}
        meta={
          connect.data && (
            <span className={`status status-${recent ? 'success' : 'muted'}`}>
              <span className="dot" aria-hidden="true" />
              {last === null ? (
                t('connect.never')
              ) : (
                <>
                  {t(recent ? 'connect.connected' : 'connect.lastCall')} <RelativeTime iso={last} />
                </>
              )}
            </span>
          )
        }
      >
        <p className="muted">{t('settings.claudeHint')}</p>
        <ol className="connect-steps">
          <li>
            <b>{t('connect.step.marketplace')}</b>
            <Command text={`claude plugin marketplace add ${MARKETPLACE}`} />
          </li>
          <li>
            <b>{t('connect.step.install')}</b>
            <Command text={`claude plugin install ${PLUGIN} --scope user`} />
          </li>
          <li>
            <b>{t('connect.step.configure')}</b>
            <Command text={`/plugin configure ${PLUGIN}`} />
            <p className="hint">{t('connect.urlLabel')}</p>
            {connect.data?.agentUrl ? (
              <Command text={connect.data.agentUrl} />
            ) : connect.data ? (
              <p className="hint">{t('connect.urlTbd')}</p>
            ) : null}
            <p className="hint">{t('connect.tokenLabel')}</p>
            <TokenControls />
          </li>
          <li>
            <b>{t('connect.step.removeManual')}</b>
            <p className="hint">{t('connect.removeManualHint')}</p>
            <Command text="claude mcp remove heph --scope user" />
          </li>
          <li>
            <b>{t('connect.step.link')}</b>
            <p className="hint">{t('connect.linkHint')}</p>
          </li>
        </ol>
      </Box>
    </section>
  );
}

/** A command or value with a Copy button. */
function Command({ text }: { text: string }) {
  const t = useT();
  const notices = useNotices();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      notices.info('connect.copied');
    } catch {
      notices.info('connect.copyManual');
    }
  };
  return (
    <div className="command">
      <code>{text}</code>
      <Button size="sm" onClick={() => void copy()} aria-label={`${t('settings.copy')}: ${text}`}>
        {t('settings.copy')}
      </Button>
    </div>
  );
}

/** Show / copy / regenerate the API token (D45). */
function TokenControls() {
  const t = useT();
  const notices = useNotices();
  const [token, setToken] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const show = useApiMutation(() => api.apiToken(), { onSuccess: (r) => setToken(r.apiToken) });
  const rotate = useApiMutation(() => api.rotateApiToken(), {
    onSuccess: (r) => {
      setToken(r.apiToken);
      setConfirm(false);
      notices.info('settings.tokenRotated');
    },
  });
  const copy = async () => {
    let value = token;
    try {
      value ??= (await api.apiToken()).apiToken;
    } catch (err) {
      notices.error(err);
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      notices.info('settings.copied');
    } catch {
      setToken(value);
      notices.info('settings.copyManual');
    }
  };
  return (
    <>
      <div className="token">{token ?? '••••••••••••••••••••'}</div>
      <div className="row">
        <Button size="sm" onClick={() => (token ? setToken(null) : show.mutate(undefined))}>
          {t(token ? 'settings.hide' : 'settings.show')}
        </Button>
        <Button size="sm" onClick={() => void copy()}>
          {t('settings.copy')}
        </Button>
        <Button size="sm" variant="danger" onClick={() => setConfirm(true)}>
          {t('settings.rotate')}
        </Button>
      </div>
      {confirm && (
        <Dialog
          title={t('settings.rotateTitle')}
          onClose={() => setConfirm(false)}
          actions={
            <>
              <Button onClick={() => setConfirm(false)}>{t('common.cancel')}</Button>
              <Button
                variant="danger"
                disabled={rotate.isPending}
                onClick={() => rotate.mutate(undefined)}
              >
                {t('settings.rotate')}
              </Button>
            </>
          }
        >
          <p>{t('settings.rotateText')}</p>
        </Dialog>
      )}
    </>
  );
}
