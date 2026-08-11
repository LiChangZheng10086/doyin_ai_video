import React from 'react';
import type { LucideIcon } from 'lucide-react';

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <section className="flex flex-col items-center justify-center py-16 text-center">
      <Icon size={40} className="mb-4 text-tech-muted" />
      <h3 className="text-base font-semibold text-tech-text">{title}</h3>
      {description && <p className="mt-1 text-sm text-tech-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </section>
  );
}
