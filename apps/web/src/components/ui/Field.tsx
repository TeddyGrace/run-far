import clsx from "clsx";
import type { InputHTMLAttributes, ReactNode } from "react";

/** The one input spec. bg-surface-2 so the control sits visibly above the row it's in. */
export const inputClass =
  "w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-base text-ink-primary placeholder:text-ink-muted disabled:opacity-50 sm:text-sm";

export function Field({
  id,
  label,
  help,
  below,
  className,
  ...rest
}: {
  id: string;
  label: string;
  help?: ReactNode;
  /** Anything that belongs under the input but isn't help text — a "forgot password" link. */
  below?: ReactNode;
} & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm text-ink-secondary">
        {label}
      </label>
      <input id={id} className={clsx(inputClass, className)} {...rest} />
      {help && <p className="mt-1.5 text-xs text-ink-secondary">{help}</p>}
      {below}
    </div>
  );
}

/** One error shape for the whole settings tree, replacing the four that had drifted apart. */
export function FieldError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p className="mt-3 text-sm text-zone-red">{children}</p>;
}

export function FieldSuccess({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p className="mt-3 text-sm text-zone-good">{children}</p>;
}
