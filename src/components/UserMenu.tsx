"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { LayoutDashboard, LogOut, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { signOutAction } from "@/lib/auth-actions";

type UserMenuProps = {
  name?: string | null;
  email?: string | null;
  isAdmin?: boolean;
};

function initials(name?: string | null, email?: string | null): string {
  const source = (name ?? email ?? "").trim();
  if (!source) return "?";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

function InitialsBadge({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex items-center justify-center rounded-full font-semibold select-none ring-1 ring-inset",
        // Light: a crisp hairline ring plus a small *directional* drop shadow reads
        // as a refined, elevated chip — the old even 0-offset glow looked smudged.
        // Dark: a recessed, near-transparent fill so the badge sits quietly at rest
        // instead of looking permanently hovered; the trigger's bg-accent hover then
        // clearly brightens it.
        "bg-background text-foreground/90 ring-black/[0.07] shadow-[0_1px_2px_rgba(0,0,0,0.08)]",
        "dark:bg-white/[0.04] dark:text-foreground/90 dark:ring-transparent dark:shadow-none",
        className
      )}
    >
      {label}
    </span>
  );
}

/* Icon tile used by every menu row: a soft square holding the row's glyph.
   The hover highlight lives on the row itself (see DropdownMenuItem), so the
   whole row — icon + label — lifts into one white box together. */
function ItemTile({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "flex size-8 items-center justify-center rounded-lg bg-transparent text-foreground/80 transition-colors group-focus/item:bg-background dark:group-focus/item:bg-white/[0.04] group-focus/item:shadow-sm",
        className
      )}
    >
      {children}
    </span>
  );
}

export function UserMenu({ name, email, isAdmin }: UserMenuProps) {
  const label = initials(name, email);
  const [open, setOpen] = useState(false);

  // The frosted page-dim overlay is portaled to <body>: the sticky header has
  // a backdrop-filter, which would capture `position: fixed` and trap the
  // overlay inside the bar (same trick as NewsModal). Gate on mount for SSR.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <>
      {mounted &&
        createPortal(
          <div
            aria-hidden="true"
            className={cn(
              // Deliberately lighter than the modal overlay (bg-black/30 +
              // blur-xl): a dropdown is transient, so the dim should whisper,
              // not shout. Always mounted + opacity transition so the blur
              // fades out smoothly instead of vanishing when the menu closes.
              "pointer-events-none fixed inset-0 z-[60] bg-black/15 dark:bg-black/30 backdrop-blur-md transition-opacity duration-300",
              open ? "opacity-100" : "opacity-0"
            )}
          />,
          document.body
        )}

      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          aria-label="Open account menu"
          className="group rounded-full outline-none transition-transform active:scale-95 cursor-pointer"
        >
          <InitialsBadge
            label={label}
            className="size-9 text-sm transition-colors group-hover:bg-accent group-hover:text-foreground"
          />
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="end"
          sideOffset={12}
          className="z-[70] w-72 rounded-3xl bg-white/75 dark:bg-card/75 backdrop-blur-2xl backdrop-saturate-150 shadow-2xl"
        >
          <div className="flex items-center gap-3 rounded-2xl bg-gradient-to-br from-muted/80 via-muted/40 to-transparent p-3">
            <InitialsBadge label={label} className="size-10 text-sm" />
            <div className="min-w-0">
              {name ? (
                <p className="truncate text-sm font-semibold leading-tight">
                  {name}
                </p>
              ) : null}
              {email ? (
                <p className="truncate text-xs text-muted-foreground leading-tight">
                  {email}
                </p>
              ) : null}
            </div>
          </div>

          <div className="mt-2 flex flex-col gap-1">
            <DropdownMenuItem
              asChild
              className="group/item gap-3 rounded-xl px-2 py-1.5 focus:bg-transparent"
            >
              <Link href="/">
                <ItemTile>
                  <LayoutDashboard className="size-4 text-foreground/80 transition-colors group-focus/item:text-foreground" />
                </ItemTile>
                <span className="text-sm font-medium transition-transform duration-200 group-focus/item:translate-x-0.5">
                  Dashboard
                </span>
              </Link>
            </DropdownMenuItem>

            {isAdmin ? (
              <DropdownMenuItem
                asChild
                className="group/item gap-3 rounded-xl px-2 py-1.5 focus:bg-transparent"
              >
                <Link href="/admin">
                  <ItemTile>
                    <ShieldCheck className="size-4 text-foreground/80 transition-colors group-focus/item:text-foreground" />
                  </ItemTile>
                  <span className="text-sm font-medium transition-transform duration-200 group-focus/item:translate-x-0.5">
                    Admin
                  </span>
                </Link>
              </DropdownMenuItem>
            ) : null}

            <form action={signOutAction}>
              <DropdownMenuItem
                asChild
                className="group/item gap-3 rounded-xl px-2 py-1.5 focus:bg-transparent"
              >
                <button type="submit" className="w-full">
                  <ItemTile>
                    <LogOut className="size-4 text-foreground/80 transition-colors group-focus/item:text-foreground" />
                  </ItemTile>
                  <span className="text-sm font-medium transition-transform duration-200 group-focus/item:translate-x-0.5">
                    Sign out
                  </span>
                </button>
              </DropdownMenuItem>
            </form>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
