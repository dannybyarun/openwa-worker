import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowRight, X } from 'lucide-react';
import { chatIdToNumber, toChatId } from '../lib/api';

interface NewChatDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStart: (chatId: string) => void;
}

export function NewChatDialog({ open, onOpenChange, onStart }: NewChatDialogProps) {
  const [value, setValue] = useState('');

  useEffect(() => {
    if (open) setValue('');
  }, [open]);

  const chatId = toChatId(value);
  const valid = chatId.length > 0;

  const submit = () => {
    if (!valid) return;
    onStart(chatId);
    onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content p-5" aria-describedby={undefined}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="text-[17px] font-semibold text-ink">New chat</Dialog.Title>
              <p className="mt-1 text-[12.5px] leading-5 text-muted">
                Enter a phone number in international format, or paste a WhatsApp JID.
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

          <input
            autoFocus
            value={value}
            onChange={event => setValue(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') submit();
            }}
            placeholder="+977 9800000000"
            className="mt-4 w-full rounded-lg bg-panel-2 px-3 py-2.5 text-[14px] text-ink outline-none ring-1 ring-transparent focus:ring-accent/60"
          />

          <div className="mt-2 min-h-5 text-[11.5px] text-muted">
            {valid ? (
              <>
                Sends to <code className="rounded bg-panel-2 px-1 text-ink">{chatId}</code>
                {chatId.endsWith('@s.whatsapp.net') && ` · ${chatIdToNumber(chatId)}`}
              </>
            ) : (
              'Digits only is fine — the country code is required.'
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
