import type { ReactNode } from 'react';

const colors = ['blue', 'teal', 'violet', 'coral', 'amber', 'slate'] as const;
export type AvatarColor = (typeof colors)[number];
export const avatarColors: readonly AvatarColor[] = colors;

export function UserAvatar({
  name,
  color,
  className = '',
}: {
  name: string;
  color: string;
  className?: string;
}): ReactNode {
  const initials = name
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <span
      className={`user-avatar ${className}`}
      data-avatar-color={colors.includes(color as AvatarColor) ? color : 'blue'}
      aria-hidden="true"
    >
      {initials || '?'}
    </span>
  );
}
