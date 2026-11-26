import { XIcon } from '@primer/octicons-react';
import { useId, useState } from 'react';
import { Button } from '../../components/ui.js';
import { useT } from '../../i18n/index.js';

/** Same limits as `Settings.testCommandPatterns` in @heph/schema. */
const MAX_PATTERNS = 100;
const MAX_LENGTH = 200;

/**
 * Test-command recognition (mockup 31): when Claude runs a command that
 * starts with one of these, the project shows "Claude running tests".
 * Saved with the rest of the settings form.
 */
export function TestPatterns({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const t = useT();
  const id = useId();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<'connect.patternDuplicate' | 'connect.patternFull' | null>(
    null,
  );
  const add = () => {
    const p = draft.trim();
    if (!p) return;
    if (value.includes(p)) return setError('connect.patternDuplicate');
    if (value.length >= MAX_PATTERNS) return setError('connect.patternFull');
    setError(null);
    onChange([...value, p]);
    setDraft('');
  };
  return (
    <div className="patterns">
      {value.length === 0 && <p className="hint">{t('connect.patternsEmpty')}</p>}
      <ul>
        {value.map((p) => (
          <li key={p}>
            <code>{p}</code>
            <Button
              size="sm"
              variant="invisible"
              aria-label={t('connect.removePattern', { pattern: p })}
              onClick={() => onChange(value.filter((x) => x !== p))}
            >
              <XIcon size={16} />
            </Button>
          </li>
        ))}
      </ul>
      <div className="patterns-add">
        <label htmlFor={id} className="sr-only">
          {t('connect.newPattern')}
        </label>
        <input
          id={id}
          value={draft}
          maxLength={MAX_LENGTH}
          placeholder={t('connect.patternPlaceholder')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter adds the pattern instead of submitting the whole form.
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button onClick={add}>{t('connect.addPattern')}</Button>
      </div>
      {error && (
        <p className="hint error" role="alert">
          {t(error)}
        </p>
      )}
    </div>
  );
}
