import { Link } from '@tanstack/react-router';
import { Activity, ListTree, Workflow } from 'lucide-react';
import type React from 'react';
import { cn } from '@/lib/utils';

/** Shared chrome for the two live-inspection routes. */

const NAV = [
  { to: '/inspect', label: 'Inspect', icon: ListTree, testId: 'nav-inspect' },
  { to: '/visualize', label: 'Visualize', icon: Workflow, testId: 'nav-visualize' },
] as const;

export function InspectHeader({
  current,
  children,
}: {
  current: '/inspect' | '/visualize';
  children?: React.ReactNode;
}) {
  return (
    <header className="flex h-11 shrink-0 items-center justify-between border-b border-border px-3">
      <div className="flex items-center gap-3">
        <Link to="/" className="text-sm font-semibold">
          Stately Sketch
        </Link>
        <nav className="flex items-center gap-0.5 rounded-md bg-muted/60 p-0.5">
          {NAV.map(({ to, label, icon: Icon, testId }) => (
            <Link
              key={to}
              to={to}
              data-testid={testId}
              aria-current={current === to ? 'page' : undefined}
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded px-2 text-xs text-muted-foreground',
                'hover:text-foreground',
                current === to && 'bg-card text-foreground shadow-sm',
              )}
            >
              <Icon className="size-3.5" />
              {label}
            </Link>
          ))}
        </nav>
      </div>
      <div className="flex items-center gap-1">{children}</div>
    </header>
  );
}

export function WaitingForInspection({
  route,
}: {
  route: '/inspect' | '/visualize';
}) {
  return (
    <main className="flex h-screen flex-col bg-background text-foreground">
      <InspectHeader current={route} />
      <div className="flex flex-1 items-center justify-center">
        <div className="max-w-md px-6 text-center">
          <Activity className="mx-auto mb-4 size-8 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Waiting for inspection</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Use{' '}
            <code className="font-mono">
              createBrowserInspector({`{ url: 'https://sketch.stately.ai${route}' }`})
            </code>
            .
          </p>
        </div>
      </div>
    </main>
  );
}

export function PanelButton({
  active,
  icon,
  label,
  onClick,
  testId,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      aria-pressed={active}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs hover:bg-muted',
        active && 'bg-muted text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  );
}
