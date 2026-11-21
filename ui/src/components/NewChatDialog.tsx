import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowRight, X } from 'lucide-react';
import { chatIdToNumber, toChatId } from '../lib/api';
import {
  COUNTRIES,
  browserRegion,
  composePhone,
  countryByCode,
  countryFromPhone,
  type Country,
} from '../lib/countries';

const COUNTRY_KEY = 'openwa:country';

interface NewChatDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStart: (chatId: string) => void;
  /** The linked account's JID (`977…:12@s.whatsapp.net`); its country is the best default. */
  accountId?: string;
}

function savedCountry(): string | undefined {
  try {
    return localStorage.getItem(COUNTRY_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function defaultCountry(accountId?: string): Country {
  const saved = countryByCode(savedCountry());
  if (saved) return saved;
  const account = accountId ? countryFromPhone(accountId.split('@')[0]?.split(':')[0] ?? '') : undefined;
  if (account) return account;
  return countryByCode(browserRegion()) ?? countryByCode('US') ?? COUNTRIES[0]!;
}

export function NewChatDialog({ open, onOpenChange, onStart, accountId }: NewChatDialogProps) {
  const [country, setCountry] = useState<Country>(() => defaultCountry(accountId));
  const [value, setValue] = useState('');

  useEffect(() => {
    if (open) {
      setCountry(defaultCountry(accountId));
      setValue('');
    }
  }, [open, accountId]);

  const isJid = value.includes('@');
  const digits = isJid ? '' : composePhone(country.dial, value);
  const chatId = isJid ? value.trim() : toChatId(digits);
  const valid = isJid ? value.trim().length > 3 : digits.length >= 7 && digits.length <= 15;

  const pickCountry = (code: string) => {
    const next = countryByCode(code);
    if (!next) return;
    setCountry(next);
    try {
      localStorage.setItem(COUNTRY_KEY, next.code);
    } catch {
      // Storage may be blocked; the picker still works for this session.
    }
  };

  // A pasted +44… or 0044… number carries its own country, so move the picker with it.
  const onChange = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed.includes('@') && (trimmed.startsWith('+') || trimmed.startsWith('00'))) {
      const digits = trimmed.startsWith('00')
        ? trimmed.replace(/[^0-9]/g, '').replace(/^00/, '')
        : trimmed.replace(/[^0-9]/g, '');
      const detected = countryFromPhone(digits, country.code);
      if (detected) {
        setCountry(detected);
        setValue(digits.slice(detected.dial.length));
        return;
      }
    }
    setValue(raw);
  };

  const submit = () => {
    if (!valid) return;
    try {
      localStorage.setItem(COUNTRY_KEY, country.code);
    } catch {
      // Ignore storage failures.
    }
    onStart(chatId);
    onOpenChange(false);
  };

  const hint = useMemo(() => {
    if (isJid) return 'A WhatsApp JID is used as-is.';
    if (!value.trim()) return 'Type the local number — the country code is added for you.';
    if (digits.length < 7) return 'That number looks too short.';
    if (digits.length > 15) return 'International numbers are at most 15 digits.';
    return `Sends to +${digits}`;
  }, [isJid, value, digits]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content p-5" aria-describedby={undefined}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="text-[17px] font-semibold text-ink">New chat</Dialog.Title>
              <p className="mt-1 text-[12.5px] leading-5 text-muted">
                Pick your country and type the local number, or paste a full international number
                or WhatsApp JID.
              </p>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="grid size-8 place-items-center rounded-full text-muted transition hover:bg-hover hover:text-ink"
                aria-label="Close"
              >
                <X size={17} />
              </button>
            </Dialog.Close>
          </div>

          <div className="mt-4 flex gap-2">
            <select
              aria-label="Country"
              value={country.code}
              onChange={event => pickCountry(event.target.value)}
              className="w-[46%] shrink-0 rounded-lg bg-panel-2 px-2.5 py-2.5 text-[13px] text-ink outline-none ring-1 ring-transparent focus:ring-accent/60"
            >
              {COUNTRIES.map(item => (
                <option key={item.code} value={item.code}>
                  {item.name} (+{item.dial})
                </option>
              ))}
            </select>
            <input
              autoFocus
              value={value}
              onChange={event => onChange(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') submit();
              }}
              inputMode={isJid ? 'text' : 'tel'}
              placeholder={isJid ? '120363…@g.us' : '9800000000'}
              className="min-w-0 flex-1 rounded-lg bg-panel-2 px-3 py-2.5 text-[14px] text-ink outline-none ring-1 ring-transparent focus:ring-accent/60"
            />
          </div>

          <div className="mt-2 min-h-5 text-[11.5px] text-muted">
            {valid ? (
              <>
                {hint}
                {chatId.endsWith('@s.whatsapp.net') && (
                  <>
                    {' · '}
                    <code className="rounded bg-panel-2 px-1 text-ink">{chatIdToNumber(chatId)}</code>
                  </>
                )}
              </>
            ) : (
              hint
            )}
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-lg px-3 py-2 text-[13px] font-medium text-muted transition hover:bg-hover hover:text-ink"
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              onClick={submit}
              disabled={!valid}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white transition hover:bg-accent-strong disabled:opacity-50"
            >
              Start chat <ArrowRight size={15} />
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
