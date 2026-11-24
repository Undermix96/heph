/** UI strings (IT/EN). A real i18n library arrives with the full UI. */
export const strings = {
  it: {
    setupTitle: 'Primo avvio',
    setupIntro: "Crea l'utente per accedere a Hephaestus. Questa pagina compare una sola volta.",
    loginTitle: 'Accedi a Hephaestus',
    username: 'Nome utente',
    password: 'Password',
    passwordConfirm: 'Ripeti la password',
    passwordMismatch: 'Le password non coincidono',
    createUser: 'Crea utente',
    signIn: 'Accedi',
    signOut: 'Esci',
    loading: 'Caricamento…',
    welcome: 'Accesso eseguito come',
    apiTokenTitle: 'Token API',
    apiTokenHint: 'Serve per collegare Claude Code. Lo ritrovi nelle Impostazioni.',
    wip: "L'interfaccia completa è in lavorazione.",
    unreachable: 'Il server non risponde.',
  },
  en: {
    setupTitle: 'First run',
    setupIntro: 'Create the user to sign in to Hephaestus. This page is shown only once.',
    loginTitle: 'Sign in to Hephaestus',
    username: 'Username',
    password: 'Password',
    passwordConfirm: 'Repeat password',
    passwordMismatch: 'Passwords do not match',
    createUser: 'Create user',
    signIn: 'Sign in',
    signOut: 'Sign out',
    loading: 'Loading…',
    welcome: 'Signed in as',
    apiTokenTitle: 'API token',
    apiTokenHint: 'Used to connect Claude Code. You can find it again in Settings.',
    wip: 'The full interface is a work in progress.',
    unreachable: 'The server is not responding.',
  },
} as const;

export type Lang = keyof typeof strings;
export type Strings = (typeof strings)[Lang];

export function detectLang(): Lang {
  return navigator.language.toLowerCase().startsWith('it') ? 'it' : 'en';
}
