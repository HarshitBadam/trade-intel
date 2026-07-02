"use client";

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
        // Light mode is borderless — no ring — but a soft, even halo (offset-free,
        // pill-strength) gives the circle just enough definition against the bar;
        // hover adds a body highlight (see trigger). The ring stays dark-only.
        "bg-background text-foreground/90 ring-transparent shadow-[0_0_5px_rgba(0,0,0,0.14)]",
        "dark:text-foreground/90 dark:ring-white/12 dark:shadow-[0_0_5px_rgba(0,0,0,0.4)]",
        className
      )}
    >
      {label}
    </span>
  );
}

export function UserMenu({ name, email, isAdmin }: UserMenuProps) {
  const label = initials(name, email);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Open account menu"
        className="group rounded-full outline-none transition-transform focus-visible:ring-2 focus-visible:ring-ring/60 active:scale-95 cursor-pointer"
      >
        <InitialsBadge
          label={label}
          className="size-9 text-sm transition-colors group-hover:bg-accent group-hover:text-foreground"
        />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" sideOffset={10} className="w-72">
        <div className="flex items-center gap-3 rounded-2xl bg-muted/50 p-3">
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
            className="gap-3 rounded-xl px-2 py-1.5 focus:bg-muted/70"
          >
            <Link href="/">
              <span className="flex size-8 items-center justify-center rounded-lg bg-muted text-foreground/80">
                <LayoutDashboard className="size-4 text-foreground/80" />
              </span>
              <span className="text-sm font-medium">Dashboard</span>
            </Link>
          </DropdownMenuItem>

          {isAdmin ? (
            <DropdownMenuItem
              asChild
              className="gap-3 rounded-xl px-2 py-1.5 focus:bg-muted/70"
            >
              <Link href="/admin">
                <span className="flex size-8 items-center justify-center rounded-lg bg-muted text-foreground/80">
                  <ShieldCheck className="size-4 text-foreground/80" />
                </span>
                <span className="text-sm font-medium">Admin</span>
              </Link>
            </DropdownMenuItem>
          ) : null}
        </div>

        <div className="mt-1.5 pt-1.5">
          <form action={signOutAction}>
            <DropdownMenuItem
              asChild
              className="gap-3 rounded-xl px-2 py-1.5 focus:bg-muted/70"
            >
              <button type="submit" className="w-full">
                <span className="flex size-8 items-center justify-center rounded-lg bg-muted text-foreground/80">
                  <LogOut className="size-4 text-foreground/80" />
                </span>
                <span className="text-sm font-medium">Sign out</span>
              </button>
            </DropdownMenuItem>
          </form>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
