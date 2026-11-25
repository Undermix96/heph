import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo } from 'react';
import { en } from './en.js';
import { it, type MessageKey } from './it.js';

export type Lang = 'it' | 'en';
export type { MessageKey };

const MESSAGES: Record<Lang, Record<MessageKey, string>> = { it, en };

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

interface I18n {
  lang: Lang;
  t: Translate;
  /** Relative time ("3 giorni fa") with the absolute date as `title`. */
  relative: (iso: string) => { text: string; title: string };
  date: (iso: string) => string;
  number: (n: number) => string;
}

const Ctx = createContext<I18n | null>(null);

export function detectLang(): Lang {
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('it')
    ? 'it'
    : 'en';
}

/** Replaces `{name}` placeholders; unknown placeholders stay visible (never silent). */
export function format(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export function makeI18n(lang: Lang, now: () => number = Date.now): I18n {
  const messages = MESSAGES[lang];
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  const dtf = new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' });
  const nf = new Intl.NumberFormat(lang);
  const t: Translate = (key, vars) => format(messages[key] ?? key, vars);
  const relative = (iso: string) => {
    const ms = Date.parse(iso);
    const title = Number.isNaN(ms) ? iso : dtf.format(ms);
    if (Number.isNaN(ms)) return { text: iso, title };
    const sec = Math.round((ms - now()) / 1000);
    const abs = Math.abs(sec);
    const [value, unit]: [number, Intl.RelativeTimeFormatUnit] =
      abs < 45
        ? [0, 'second']
        : abs < 3600
          ? [Math.round(sec / 60), 'minute']
          : abs < 86_400
            ? [Math.round(sec / 3600), 'hour']
            : abs < 30 * 86_400
              ? [Math.round(sec / 86_400), 'day']
              : abs < 365 * 86_400
                ? [Math.round(sec / (30 * 86_400)), 'month']
                : [Math.round(sec / (365 * 86_400)), 'year'];
    return { text: value === 0 ? t('time.now') : rtf.format(value, unit), title };
  };
  return {
    lang,
    t,
    relative,
    date: (iso) => {
      const ms = Date.parse(iso);
      return Number.isNaN(ms) ? iso : dtf.format(ms);
    },
    number: (n) => nf.format(n),
  };
}

export function I18nProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  const value = useMemo(() => makeI18n(lang), [lang]);
  // Screen readers and hyphenation follow the chosen language (WCAG 3.1.1).
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error('useI18n outside I18nProvider');
  return v;
}

export function useT(): Translate {
  const { t } = useI18n();
  return useCallback<Translate>((k, v) => t(k, v), [t]);
}
