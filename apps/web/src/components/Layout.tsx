import type { ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import clsx from "clsx";
import { useAuth, useLogout } from "../lib/auth.js";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard" },
  { to: "/calendar", label: "Calendar" },
  { to: "/build", label: "Build" },
  { to: "/settings", label: "Settings" },
];

// The week grid needs far more horizontal room than the reading-width pages.
const WIDE_ROUTES = ["/calendar"];

export function Layout({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const logout = useLogout();
  const { pathname } = useLocation();
  const containerWidth = WIDE_ROUTES.some((route) => pathname.startsWith(route))
    ? "max-w-[1600px]"
    : "max-w-5xl";

  return (
    <div className="min-h-screen bg-surface-0">
      <header className="border-b border-border">
        <div
          className={clsx("mx-auto flex items-center justify-between px-6 py-4", containerWidth)}
        >
          <div className="flex items-center gap-8">
            <span className="font-display text-lg font-semibold tracking-tight text-ink-primary">
              run-far
            </span>
            <nav className="flex gap-1">
              {NAV_ITEMS.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === "/"}
                  className={({ isActive }) =>
                    clsx(
                      "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                      isActive
                        ? "bg-surface-2 text-ink-primary"
                        : "text-ink-secondary hover:text-ink-primary",
                    )
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>
          {user && (
            <div className="flex items-center gap-3 text-sm text-ink-secondary">
              <span>{user.email}</span>
              <button
                onClick={() => logout()}
                className="rounded-md px-2.5 py-1 text-ink-secondary transition-colors hover:bg-surface-1 hover:text-ink-primary"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>
      <main className={clsx("mx-auto px-6 py-8", containerWidth)}>{children}</main>
    </div>
  );
}
