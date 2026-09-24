"use client";

import clsx from "clsx";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  FolderClosed,
  Layers,
  Link2,
  LogOut,
  PanelLeft,
  PenSquare,
  Search,
  Shield,
  SquareCode,
  X,
} from "lucide-react";
import { Avatar } from "@/components/ds";
import { logout } from "@/server/auth-actions";

export type SidebarThread = {
  id: string;
  title: string;
  time: string;
  group: string;
};

export type SidebarUser = {
  name: string;
  initials: string;
  avatarTint: string;
  avatarInk: string;
  line: string;
  isAdmin: boolean;
  isCreator: boolean;
};

export type SidebarCounts = {
  workspace: number;
  accountsNeedAttention: boolean;
};

const iconProps = {
  size: 18,
  strokeWidth: 1.8,
  className: "flex-none",
} as const;

export function Sidebar({
  user,
  threads,
  counts,
}: {
  user: SidebarUser;
  threads: SidebarThread[];
  counts: SidebarCounts;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  const nav = [
    { href: "/", label: "New task", icon: <PenSquare {...iconProps} />, exact: true },
    { href: "/marketplace", label: "Marketplace", icon: <Layers {...iconProps} /> },
    {
      href: "/workspace",
      label: "My workspace",
      icon: <FolderClosed {...iconProps} />,
      trailing: <span className="text-xs text-ink-3">{counts.workspace}</span>,
    },
    { href: "/results", label: "Results", icon: <SquareCode {...iconProps} /> },
    {
      href: "/accounts",
      label: "Connected accounts",
      icon: <Link2 {...iconProps} />,
      trailing: counts.accountsNeedAttention ? (
        <span className="size-[7px] rounded-full bg-warn" />
      ) : null,
    },
    ...(user.isCreator
      ? [{ href: "/creator", label: "Creator studio", icon: <SquareCode {...iconProps} /> }]
      : []),
    ...(user.isAdmin
      ? [{ href: "/admin", label: "Admin", icon: <Shield {...iconProps} /> }]
      : []),
  ];

  const isActive = (href: string, exact?: boolean) =>
    exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  const groups = threads.reduce<Record<string, SidebarThread[]>>((acc, thread) => {
    (acc[thread.group] ??= []).push(thread);
    return acc;
  }, {});

  const panel = (
    <div className="flex h-full w-[260px] flex-none flex-col border-r border-selected bg-sidebar">
      <div className="flex h-14 items-center justify-between pr-3 pl-4">
        <Link href="/" className="flex items-center gap-2.5 text-ink">
          <span className="flex size-[26px] items-center justify-center rounded-[8px] bg-ink text-sm font-semibold text-white">
            B
          </span>
          <span className="text-base font-semibold tracking-[-0.01em]">Builder</span>
        </Link>
        <div className="flex gap-0.5 text-ink-2">
          <button
            type="button"
            aria-label="Search"
            className="flex size-[34px] items-center justify-center rounded-[8px] hover:bg-selected"
          >
            <Search {...iconProps} />
          </button>
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="flex size-[34px] items-center justify-center rounded-[8px] hover:bg-selected md:hidden"
          >
            <X {...iconProps} />
          </button>
          <span className="hidden size-[34px] items-center justify-center rounded-[8px] text-ink-2 md:flex">
            <PanelLeft {...iconProps} />
          </span>
        </div>
      </div>

      <nav className="flex flex-col gap-px px-2 pb-1">
        {nav.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setOpen(false)}
            className={clsx(
              "flex h-9 items-center gap-2.5 rounded-row px-2.5 text-sm text-ink",
              isActive(item.href, item.exact) ? "bg-selected" : "hover:bg-selected/60",
            )}
          >
            {item.icon}
            <span className="flex-1 truncate">{item.label}</span>
            {item.trailing}
          </Link>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto px-2 pt-4">
        {Object.entries(groups).map(([group, items]) => (
          <div key={group}>
            <div className="px-2.5 pt-2.5 pb-1.5 text-xs text-ink-3">{group}</div>
            {items.map((thread) => (
              <Link
                key={thread.id}
                href={`/tasks/${thread.id}`}
                onClick={() => setOpen(false)}
                className={clsx(
                  "flex h-[34px] items-center justify-between gap-2 rounded-row px-2.5 text-sm",
                  pathname === `/tasks/${thread.id}` ? "bg-selected" : "hover:bg-selected/60",
                )}
              >
                <span className="truncate text-ink">{thread.title}</span>
                {thread.time ? (
                  <span className="flex-none text-xs text-ink-3">{thread.time}</span>
                ) : null}
              </Link>
            ))}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-1 border-t border-selected px-2 pt-2.5 pb-3">
        <Link
          href="/workspace"
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-row px-2.5 py-2 text-ink hover:bg-selected/60"
        >
          <Avatar initials={user.initials} tint={user.avatarTint} ink={user.avatarInk} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium">{user.name}</span>
            <span className="truncate text-xs text-ink-3">{user.line}</span>
          </span>
        </Link>
        <form action={logout}>
          <button
            type="submit"
            aria-label="Sign out"
            title="Sign out"
            className="flex size-8 items-center justify-center rounded-row text-ink-3 hover:bg-selected hover:text-ink"
          >
            <LogOut size={16} strokeWidth={1.8} />
          </button>
        </form>
      </div>
    </div>
  );

  return (
    <>
      {/* Phone: a bar that opens the same panel as a sheet. */}
      <div className="flex h-14 items-center gap-2 border-b border-selected bg-sidebar px-3 md:hidden">
        <button
          type="button"
          aria-label="Open menu"
          onClick={() => setOpen(true)}
          className="flex size-9 items-center justify-center rounded-[8px] text-ink-2 hover:bg-selected"
        >
          <PanelLeft {...iconProps} />
        </button>
        <Link href="/" className="flex items-center gap-2 text-ink">
          <span className="flex size-[26px] items-center justify-center rounded-[8px] bg-ink text-sm font-semibold text-white">
            B
          </span>
          <span className="text-base font-semibold tracking-[-0.01em]">Builder</span>
        </Link>
      </div>

      {open ? (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <div className="h-full">{panel}</div>
          <button
            type="button"
            aria-label="Close menu"
            className="flex-1 bg-ink/20"
            onClick={() => setOpen(false)}
          />
        </div>
      ) : null}

      <div className="hidden h-full md:block">{panel}</div>
    </>
  );
}
