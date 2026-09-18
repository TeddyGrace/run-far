import clsx from "clsx";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "dangerSolid";

/**
 * The one button spec.
 *
 * Before this existed the same button was written three ways across Settings and
 * HealthSourceCard — rounded-md vs rounded-lg, py-1.5 vs py-2, some with a hover state and
 * some without. Anything that reads as a button goes through here, including the ones that
 * are really links (Connect, Export, Backoffice), which is what `href` is for.
 */
const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-surface-0 font-medium hover:bg-accent-strong",
  secondary: "border border-border text-ink-secondary hover:text-ink-primary hover:border-ink-muted",
  danger: "border border-zone-red/40 text-zone-red hover:bg-zone-red/10",
  dangerSolid: "bg-zone-red text-surface-0 font-medium hover:opacity-90",
};

const BASE =
  "inline-flex shrink-0 items-center justify-center rounded-md px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50";

type Common = { variant?: ButtonVariant; className?: string; children: ReactNode };

export function Button({
  variant = "secondary",
  className,
  children,
  ...rest
}: Common & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={clsx(BASE, VARIANTS[variant], className)} {...rest}>
      {children}
    </button>
  );
}

export function ButtonLink({
  variant = "secondary",
  className,
  children,
  ...rest
}: Common & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a className={clsx(BASE, VARIANTS[variant], className)} {...rest}>
      {children}
    </a>
  );
}
