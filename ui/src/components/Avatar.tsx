import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { User, Users } from 'lucide-react';
import { api, type Config } from '../lib/api';
import { colorFor, initials } from '../lib/format';

interface AvatarProps {
  name: string;
  seed?: string;
  size?: number;
  online?: boolean;
  group?: boolean;
  /** WhatsApp address of this chat, used to look its profile picture up. */
  jid?: string;
  /** Cached photo from `/history` (data URL), so most avatars paint without a request. */
  photo?: string | null;
  config?: Config;
  sessionId?: string | null;
  /** When false (idle session) only the cached photo is shown — no request that would wake the DO. */
  live?: boolean;
}

/**
 * WhatsApp profile picture with an initials fallback. Photos are cached in the session's
 * Durable Object and refreshed while the socket is open, so a hidden or unknown photo simply
 * renders the coloured initial — never a broken image.
 */
export function Avatar({
  name,
  seed,
  size = 44,
  online = false,
  group = false,
  jid,
  photo,
  config,
  sessionId,
  live = true,
}: AvatarProps) {
  const [broken, setBroken] = useState(false);
  const canFetch = Boolean(live && jid && config && sessionId && !photo && !broken);

  const { data } = useQuery({
    queryKey: ['avatar', config?.base, config?.token, sessionId, jid],
    queryFn: () => api.avatar(config as Config, sessionId as string, jid as string),
    enabled: canFetch,
    staleTime: 30 * 60 * 1000,
    retry: false,
  });

  const src = !broken ? (photo ?? data?.url ?? null) : null;
  const color = colorFor(seed || name);
  // Unsaved contacts come through as a phone number; WhatsApp shows a person glyph
  // there, not the digit.
  const contactOnly = !group && !/\p{L}/u.test(name);

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <div
        className="flex h-full w-full items-center justify-center overflow-hidden rounded-full font-semibold text-white select-none"
        style={{ background: color, fontSize: Math.max(11, size * 0.36) }}
        aria-hidden="true"
      >
        {src ? (
          <img
            src={src}
            alt=""
            loading="lazy"
            onError={() => setBroken(true)}
            className="h-full w-full object-cover"
          />
        ) : group ? (
          <Users size={Math.max(14, size * 0.46)} strokeWidth={2} />
        ) : contactOnly ? (
          <User size={Math.max(14, size * 0.5)} strokeWidth={2} />
        ) : (
          initials(name)
        )}
      </div>
      {online && (
        <span
          className="absolute right-0 bottom-0 block rounded-full bg-accent ring-2 ring-panel"
          style={{ width: Math.max(9, size * 0.24), height: Math.max(9, size * 0.24) }}
        />
      )}
    </div>
  );
}
