import React from 'react';
import type { LucideIcon } from 'lucide-react';

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  icon: LucideIcon;
}

export function IconButton({ label, icon: Icon, className = '', ...props }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`inline-flex items-center justify-center rounded-lg p-2 text-ink-muted hover:bg-elevated hover:text-ink focus-visible:outline-2 focus-visible:outline-tech-blue transition-colors ${className}`}
      {...props}
    >
      <Icon size={17} />
    </button>
  );
}
