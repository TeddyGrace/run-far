import { useId, useState } from "react";
import clsx from "clsx";
import type { ReactNode } from "react";

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={clsx(
        "h-4 w-4 shrink-0 text-ink-muted transition-transform",
        open && "rotate-180",
      )}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

/**
 * A setting that shows its current state closed and its controls open.
 *
 * Most of these are things an athlete sets once — thresholds, a password, which model runs the
 * coach. Left expanded they turned the page into five screens of scroll, and the one question
 * people actually open Settings to answer ("is Whoop still connected?") was buried among them.
 * So: `summary` and `status` carry the answer in the closed row, and the controls stay folded
 * until someone wants them.
 */
export function SettingsRow({
  label,
  summary,
  status,
  defaultOpen = false,
  children,
}: {
  label: string;
  /** Current state, in plain words — "Trial · ends Apr 2", "Not set". */
  summary?: ReactNode;
  /** A Badge, for state that reads better as a pill than as a sentence. */
  status?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-surface-2/50"
      >
        <span className="shrink-0 text-sm font-medium text-ink-primary">{label}</span>
        <span className="ml-auto flex min-w-0 items-center gap-2">
          {summary != null && (
            <span className="truncate text-sm text-ink-muted">{summary}</span>
          )}
          {status}
        </span>
        <Chevron open={open} />
      </button>
      {open && (
        <div id={bodyId} className="px-4 pb-4">
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * A row with nowhere to expand to — the action is the whole setting (Export my data).
 */
export function SettingsActionRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 p-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink-primary">{label}</p>
        {description && <p className="mt-0.5 text-sm text-ink-secondary">{description}</p>}
      </div>
      {children}
    </div>
  );
}

/** The explanatory line at the top of an expanded row body. */
export function RowDescription({ children }: { children: ReactNode }) {
  return <p className="text-sm text-ink-secondary">{children}</p>;
}
