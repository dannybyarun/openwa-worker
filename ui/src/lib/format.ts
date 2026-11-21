import type { Message } from './api';
import { chatIdToNumber } from './api';

const AVATAR_COLORS = [
  '#0a7cff',
  '#00a884',
  '#f2a33c',
  '#e0645b',
  '#8e6cef',
  '#00a5b5',
  '#c25bb0',
  '#5b8def',
  '#b8860b',
  '#3d9a5c',
];

export function colorFor(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function initials(name: string): string {
  const letters = name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase() ?? '')
    .join('');
  return letters || '#';
}

export function displayName(chatId: string, pushName?: string): string {
  const trimmed = pushName?.trim();
  if (trimmed) return trimmed;
  if (chatId.endsWith('@g.us')) {
    const digits = chatId.split('@')[0] ?? '';
    return `Group · ${digits.slice(-6)}`;
  }
  return chatIdToNumber(chatId);
}

export function messagePreview(message: Message | undefined): string {
  if (!message) return 'No messages yet';
  const text = message.text?.trim();
  if (text) return text.replace(/\s+/g, ' ');
  const kind = (message.type ?? '').replace(/Message$/, '');
  const labels: Record<string, string> = {
    image: 'Photo',
    video: 'Video',
    audio: 'Voice message',
    document: 'Document',
    sticker: 'Sticker',
    location: 'Location',
    contact: 'Contact',
    reaction: 'Reaction',
  };
  return labels[kind] ?? 'Message';
}

const pad = (n: number) => String(n).padStart(2, '0');

export function clock(iso?: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function dayLabel(iso?: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const today = startOfDay(new Date());
  const day = startOfDay(date);
  const diff = Math.round((today - day) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return date.toLocaleDateString(undefined, { weekday: 'long' });
  return date.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function listTime(iso?: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const diff = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);
  if (diff === 0) return clock(iso);
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return date.toLocaleDateString(undefined, { weekday: 'short' });
  return date.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export interface ChatSummary {
  chatId: string;
  name: string;
  last?: Message;
  messages: Message[];
  unread: number;
}

/** Group the flat history into one entry per chat, newest chat first. */
export function buildChats(messages: Message[], readAt: Record<string, string>): ChatSummary[] {
  const byChat = new Map<string, Message[]>();
  for (const message of messages) {
    if (!message.chatId) continue;
    const list = byChat.get(message.chatId);
    if (list) list.push(message);
    else byChat.set(message.chatId, [message]);
  }

  const chats: ChatSummary[] = [];
  for (const [chatId, list] of byChat) {
    list.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
    const last = list[list.length - 1];
    const mark = readAt[chatId];
    const unread = mark
      ? list.filter(m => !m.fromMe && (m.timestamp ?? '') > mark).length
      : list.filter(m => !m.fromMe).length;
    const isGroup = chatId.endsWith('@g.us');
    // History only carries the sender's pushName, so keep the last one we saw from
    // the other side: the newest message may well be ours (and have no pushName).
    const contactName = isGroup
      ? undefined
      : [...list].reverse().find(m => !m.fromMe && m.pushName?.trim())?.pushName;
    chats.push({
      chatId,
      name: displayName(chatId, contactName),
      last,
      messages: list,
      unread,
    });
  }

  return chats.sort((a, b) =>
    (b.last?.timestamp ?? '').localeCompare(a.last?.timestamp ?? ''),
  );
}

export function groupByDay(messages: Message[]): Array<{ label: string; messages: Message[] }> {
  const groups: Array<{ label: string; messages: Message[] }> = [];
  for (const message of messages) {
    const label = dayLabel(message.timestamp);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.messages.push(message);
    else groups.push({ label, messages: [message] });
  }
  return groups;
}
