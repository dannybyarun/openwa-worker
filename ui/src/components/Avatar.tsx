import { User, Users } from 'lucide-react';
import { colorFor, initials } from '../lib/format';

interface AvatarProps {
  name: string;
  seed?: string;
  size?: number;
  online?: boolean;
  group?: boolean;
}

export function Avatar({ name, seed, size = 44, online = false, group = false }: AvatarProps) {
  const color = colorFor(seed || name);
  // Unsaved contacts come through as a phone number; WhatsApp shows a person glyph
  // there, not the digit.
  const contactOnly = !group && !/\p{L}/u.test(name);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <div
        className="flex h-full w-full items-center justify-center rounded-full font-semibold text-white select-none"
        style={{ background: color, fontSize: Math.max(11, size * 0.36) }}
        aria-hidden="true"
      >
        {group ? (
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
