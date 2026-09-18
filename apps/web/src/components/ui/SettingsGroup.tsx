import clsx from "clsx";
import type { ReactNode } from "react";

/**
 * One bordered container per group of settings, not per setting.
 *
 * The whole point of the settings cleanup: ten identical cards in a row gave every control the
 * same weight, so nothing read as more or less important than anything else. Grouping is the
 * hierarchy. The heading matches the section label Dashboard and AdherencePanel already use.
 */
export function SettingsGroup({
  title,
  tone = "default",
  children,
}: {
  title: string;
  tone?: "default" | "danger";
  children: ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-3 font-display text-sm font-semibold uppercase tracking-wide text-ink-secondary">
        {title}
      </h2>
      <div
        className={clsx(
          "divide-y rounded-xl border bg-surface-1",
          tone === "danger"
            ? "divide-zone-red/20 border-zone-red/30"
            : "divide-border border-border",
        )}
      >
        {children}
      </div>
    </section>
  );
}
