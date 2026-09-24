// Minimal i18n for two languages: a dictionary per language and {name} placeholders.

import { createContext, useContext } from 'react';
import { en, type MessageKey } from './en.ts';
import { ja } from './ja.ts';

export type Language = 'en' | 'ja';
export type { MessageKey };

const dictionaries: Record<Language, Record<MessageKey, string>> = { en, ja };
const STORAGE_KEY = 'mp4-to-ifo.language';

export function translate(language: Language, key: MessageKey, params: Record<string, string | number> = {}): string {
  const text = dictionaries[language][key] ?? en[key];
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
}

/** macOS language order (as the web view reports it); Japanese if it comes first, else English. */
export function systemLanguage(languages: readonly string[]): Language {
  return languages[0]?.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

export interface LanguageStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadLanguage(store: LanguageStore | undefined, languages: readonly string[]): Language {
  const saved = store?.getItem(STORAGE_KEY);
  return saved === 'en' || saved === 'ja' ? saved : systemLanguage(languages);
}

export function saveLanguage(store: LanguageStore | undefined, language: Language): void {
  store?.setItem(STORAGE_KEY, language);
}

export interface I18n {
  language: Language;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
}

export const I18nContext = createContext<I18n>({ language: 'en', t: (key, params) => translate('en', key, params) });
export const useI18n = () => useContext(I18nContext);
