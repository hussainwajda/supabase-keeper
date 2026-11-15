"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useCallback } from "react";
import { useFormStatus } from "react-dom";
import { signOut } from "@/app/auth/actions";
import {
  DatabaseZapIcon,
  LayoutDashboardIcon,
  FolderKanbanIcon,
  PlusIcon,
  ListIcon,
  UsersIcon,
  ShieldIcon,
  KeyRoundIcon,
  SettingsIcon,
  WrenchIcon,
  ServerIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  LogOutIcon,
  Loader2Icon,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface SubMenuItem {
  label: string;
  href: string;
  icon: React.ReactNode;
}

interface MenuItem {
  label: string;
  icon: React.ReactNode;
  href?: string;
  children?: SubMenuItem[];
  /** If true the menu renders as a direct link instead of expandable */
  direct?: boolean;
}

interface MenuSection {
  title: string;
  items: MenuItem[];
}

/* ------------------------------------------------------------------ */
/*  Menu definition                                                    */
/* ------------------------------------------------------------------ */

const menuSections: MenuSection[] = [
  {
    title: "Overview",
    items: [
      {
        label: "Dashboard",
        icon: <LayoutDashboardIcon className="sidebar-icon" />,
        href: "/",
        direct: true,
      },
    ],
  },
  {
    title: "Project Management",
    items: [
      {
        label: "Projects",
        icon: <FolderKanbanIcon className="sidebar-icon" />,
        children: [
          {
            label: "All Projects",
            href: "/",
            icon: <ListIcon className="sidebar-icon" />,
          },
          {
            label: "New Project",
            href: "/projects/new",
            icon: <PlusIcon className="sidebar-icon" />,
          },
        ],
      },
      {
        label: "Accounts",
        icon: <UsersIcon className="sidebar-icon" />,
        children: [
          {
            label: "All Accounts",
            href: "/accounts",
            icon: <ListIcon className="sidebar-icon" />,
          },
          {
            label: "New Account",
            href: "/accounts/new",
            icon: <PlusIcon className="sidebar-icon" />,
          },
        ],
      },
      {
        label: "Providers",
        icon: <ServerIcon className="sidebar-icon" />,
        href: "/providers",
        direct: true,
      },
    ],
  },
  {
    title: "Security",
    items: [
      {
        label: "Vault",
        icon: <ShieldIcon className="sidebar-icon" />,
        children: [
          {
            label: "Credentials",
            href: "/vault",
            icon: <KeyRoundIcon className="sidebar-icon" />,
          },
        ],
      },
    ],
  },
  {
    title: "System",
    items: [
      {
        label: "Settings",
        icon: <SettingsIcon className="sidebar-icon" />,
        children: [
          {
            label: "Setup",
            href: "/setup",
            icon: <WrenchIcon className="sidebar-icon" />,
          },
        ],
      },
    ],
  },
];

/* ------------------------------------------------------------------ */
/*  Sidebar component                                                  */
/* ------------------------------------------------------------------ */

export function Sidebar({
  user,
}: {
  user: { email?: string | null; displayName?: string | null; avatarUrl?: string | null } | null;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  // Track which menus are expanded — key is "sectionIdx-itemIdx"
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    // Auto-expand sections that contain the active page
    const initial: Record<string, boolean> = {};
    menuSections.forEach((section, si) => {
      section.items.forEach((item, ii) => {
        if (item.children?.some((c) => c.href === pathname)) {
          initial[`${si}-${ii}`] = true;
        }
      });
    });
    return initial;
  });

  const toggle = useCallback((key: string) => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  };

  return (
    <aside
      className={`sidebar-root ${collapsed ? "sidebar-collapsed" : ""}`}
      data-collapsed={collapsed}
    >
      {/* -------- Brand -------- */}
      <div className="sidebar-brand">
        {!collapsed && (
          <Link href="/" className="sidebar-brand-link">
            <DatabaseZapIcon className="sidebar-brand-icon" />
            <span className="sidebar-brand-text">Keepstack</span>
          </Link>
        )}
        {collapsed && (
          <Link href="/" className="sidebar-brand-link sidebar-brand-link--collapsed">
            <DatabaseZapIcon className="sidebar-brand-icon" />
          </Link>
        )}
        <button
          className="sidebar-collapse-btn"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? (
            <PanelLeftOpenIcon className="size-4" />
          ) : (
            <PanelLeftCloseIcon className="size-4" />
          )}
        </button>
      </div>

      {/* -------- Nav -------- */}
      <nav className="sidebar-nav" aria-label="Main navigation">
        {menuSections.map((section, si) => (
          <div key={si} className="sidebar-section">
            {!collapsed && <p className="sidebar-section-title">{section.title}</p>}
            {collapsed && <div className="sidebar-section-divider" />}

            <ul className="sidebar-menu">
              {section.items.map((item, ii) => {
                const key = `${si}-${ii}`;
                const isOpen = expanded[key] ?? false;
                const hasChildren = !!item.children?.length;
                const childActive = item.children?.some((c) => isActive(c.href)) ?? false;

                /* ---- Direct link ---- */
                if (item.direct && item.href) {
                  return (
                    <li key={ii}>
                      <Link
                        href={item.href}
                        className={`sidebar-item ${isActive(item.href) ? "sidebar-item--active" : ""}`}
                        title={collapsed ? item.label : undefined}
                      >
                        {item.icon}
                        {!collapsed && <span>{item.label}</span>}
                      </Link>
                    </li>
                  );
                }

                /* ---- Expandable menu ---- */
                return (
                  <li key={ii}>
                    <button
                      className={`sidebar-item sidebar-item--parent ${childActive ? "sidebar-item--child-active" : ""}`}
                      onClick={() => {
                        if (collapsed) {
                          setCollapsed(false);
                          setExpanded((prev) => ({ ...prev, [key]: true }));
                        } else {
                          toggle(key);
                        }
                      }}
                      title={collapsed ? item.label : undefined}
                    >
                      {item.icon}
                      {!collapsed && (
                        <>
                          <span className="flex-1 text-left">{item.label}</span>
                          <ChevronDownIcon
                            className={`sidebar-chevron ${isOpen ? "sidebar-chevron--open" : ""}`}
                          />
                        </>
                      )}
                    </button>

                    {/* Sub-menu with smooth height animation */}
                    {!collapsed && hasChildren && (
                      <div
                        className={`sidebar-submenu-wrapper ${isOpen ? "sidebar-submenu-wrapper--open" : ""}`}
                      >
                        <ul className="sidebar-submenu">
                          {item.children!.map((child, ci) => (
                            <li key={ci}>
                              <Link
                                href={child.href}
                                className={`sidebar-subitem ${isActive(child.href) ? "sidebar-subitem--active" : ""}`}
                              >
                                {child.icon}
                                <span>{child.label}</span>
                              </Link>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* -------- User footer -------- */}
      {user && (
        <div className="sidebar-footer">
          <div className="sidebar-user" title={collapsed ? (user.email ?? "Account") : undefined}>
            <div className="sidebar-avatar">
              {user.avatarUrl ? (
                <img src={user.avatarUrl} alt="" className="sidebar-avatar-img" />
              ) : (
                <span className="sidebar-avatar-fallback">
                  {(user.displayName ?? user.email ?? "U").charAt(0).toUpperCase()}
                </span>
              )}
            </div>
            {!collapsed && (
              <div className="sidebar-user-info">
                <p className="sidebar-user-name">{user.displayName ?? "User"}</p>
                <p className="sidebar-user-email">{user.email}</p>
              </div>
            )}
            {/* Sign-out: form POST so no prefetch or image request can sign you out. */}
            <form action={signOut} className={collapsed ? "" : "ml-auto"}>
              <SignOutButton collapsed={collapsed} />
            </form>
          </div>
        </div>
      )}
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/*  Sign-out button (split out so useFormStatus reads the right form)  */
/* ------------------------------------------------------------------ */

function SignOutButton({ collapsed }: { collapsed: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="sidebar-signout-btn"
      aria-label="Sign out"
      title={collapsed ? (pending ? "Signing out…" : "Sign out") : undefined}
    >
      {pending ? (
        <Loader2Icon className="size-4 animate-spin" aria-hidden />
      ) : (
        <LogOutIcon className="size-4" aria-hidden />
      )}
      {!collapsed && (
        <span className="text-xs">{pending ? "Signing out…" : ""}</span>
      )}
    </button>
  );
}
