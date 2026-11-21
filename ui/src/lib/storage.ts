import type { Config } from './api';

const LS_BASE = 'openwa:worker-url';
const LS_TOKEN = 'openwa:worker-token';
const LS_THEME = 'openwa:theme';
const LS_SESSION = 'openwa:last-session';
const LS_READ = 'openwa:read';

export function loadConfig(): Config {
  // Older builds kept an API token here so the browser could act without signing
  // in. That was the "auto login" — the UI now uses the password cookie instead,
  // so drop any leftover secret from this origin.
  localStorage.removeItem(LS_TOKEN);
  return {
    base: localStorage.getItem(LS_BASE) ?? '',
    token: '',
  };
}

export function saveConfig(config: Config): void {
  localStorage.setItem(LS_BASE, config.base.trim().replace(/\/+$/, ''));
  localStorage.removeItem(LS_TOKEN);
}

export type Theme = 'dark' | 'light';

export function loadTheme(): Theme {
  const stored = localStorage.getItem(LS_THEME);
  if (stored === 'dark' || stored === 'light') return stored;
  return 'dark';
}

export function saveTheme(theme: Theme): void {
  localStorage.setItem(LS_THEME, theme);
}

export function loadLastSession(): string {
  return localStorage.getItem(LS_SESSION) ?? '';
}

export function saveLastSession(id: string): void {
  if (id) localStorage.setItem(LS_SESSION, id);
  else localStorage.removeItem(LS_SESSION);
}

type ReadMap = Record<string, Record<string, string>>;

function readMap(): ReadMap {
  try {
    return JSON.parse(localStorage.getItem(LS_READ) ?? '{}') as ReadMap;
  } catch {
    return {};
  }
}

export function loadRead(sessionId: string): Record<string, string> {
  return readMap()[sessionId] ?? {};
}

export function markRead(sessionId: string, chatIds: string[], at: string): void {
  const map = readMap();
  const current = map[sessionId] ?? {};
  for (const chatId of chatIds) current[chatId] = at;
  map[sessionId] = current;
  localStorage.setItem(LS_READ, JSON.stringify(map));
}
