import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { Menu, LayoutDashboard, Cpu, MessageSquare, Wand2, Activity, LogOut, Power, Settings } from "lucide-react";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { useOperator } from "@/hooks/useOperator";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import operatorAvatar from "@/assets/operator-avatar.jpg";
import { SettingsDialog } from "@/components/SettingsDialog";
import { useBridgeStatus } from "@/hooks/useBridgeStatus";

const tabs = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/models", label: "Models", icon: Cpu },
  { to: "/chat", label: "Chat", icon: MessageSquare },
  { to: "/skills", label: "Skills", icon: Wand2 },
  { to: "/activity", label: "Activity", icon: Activity },
];

const SidebarBody = ({ onClose }: { onClose?: () => void }) => {
  const { profile, activeModel } = useOperator();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    navigate("/login", { replace: true });
  };

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="border-b border-sidebar-border p-5">
        <div className="flex items-center gap-3">
          <div className="relative">
            <img
              src={operatorAvatar}
              alt="Operator avatar"
              width={56}
              height={56}
              loading="lazy"
              className="h-14 w-14 rounded-full border border-cyan/40 object-cover glow-cyan-soft"
            />
            <span className="pulse-dot absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-green-neon" />
          </div>
          <div className="min-w-0">
            <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">OPERATOR</p>
            <p className="truncate text-sm font-semibold">{profile?.callsign ?? "OPERATOR_01"}</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-[11px] font-mono text-green-neon">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-neon pulse-dot" />
              {profile?.status ?? "SYSTEM ACTIVE"}
            </p>
          </div>
        </div>
        <p className="mt-3 truncate text-xs text-muted-foreground">
          {profile?.display_name ?? "Richard Berrios-Irizarry"}
        </p>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto p-3 scrollbar-thin">
        <p className="px-2 py-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Navigation
        </p>
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.to === "/"}
            onClick={onClose}
            className={({ isActive }) =>
              cn(
                "group flex items-center gap-3 rounded-md border border-transparent px-3 py-2.5 text-sm transition-colors",
                "hover:bg-sidebar-accent",
                isActive && "border-cyan/30 bg-sidebar-accent text-cyan glow-cyan-soft",
              )
            }
          >
            <t.icon className="h-4 w-4" />
            <span className="font-medium">{t.label}</span>
          </NavLink>
        ))}

        <div className="mt-6 rounded-md border border-border bg-surface-2/60 p-3">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Active model</p>
          <p className="mt-1 truncate font-mono text-xs text-cyan">{activeModel?.name ?? "—"}</p>
        </div>
      </nav>

      <div className="space-y-3 border-t border-sidebar-border p-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleSignOut}
          className="w-full justify-start gap-2 font-mono text-xs"
        >
          <LogOut className="h-4 w-4" /> SIGN OUT
        </Button>
        <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Power className="h-3 w-3 text-green-neon" /> v2.4.0-STABLE
          </span>
          <span>OPENCLAW</span>
        </div>
      </div>
    </div>
  );
};

export const AppShell = () => {
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const bridgeStatus = useBridgeStatus();

  const isOnline = bridgeStatus === "ONLINE";
  const isChecking = bridgeStatus === "CHECKING";
  const statusBorder = isOnline
    ? "border-green-neon/30"
    : isChecking
      ? "border-cyan/30"
      : "border-border";
  const statusDot = isOnline
    ? "bg-green-neon pulse-dot"
    : isChecking
      ? "bg-cyan animate-pulse"
      : "bg-muted-foreground";
  const statusText = isOnline
    ? "text-green-neon"
    : isChecking
      ? "text-cyan"
      : "text-muted-foreground";

  return (
    <div className="flex min-h-screen w-full flex-col bg-background">
      {/* Top bar */}
      <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-border bg-background/85 px-3 backdrop-blur">
        <div className="flex items-center gap-2">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Open menu" className="h-9 w-9">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[290px] border-sidebar-border bg-sidebar p-0">
              <SidebarBody onClose={() => setOpen(false)} />
            </SheetContent>
          </Sheet>
          <div className="leading-tight">
            <h1 className="font-mono text-[13px] font-semibold tracking-widest text-cyan">OPENCLAW</h1>
            <p className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">CONTROL // v2.4</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className={cn("flex items-center gap-2 rounded-full border bg-surface-2/60 px-2.5 py-1", statusBorder)}>
            <span className={cn("h-2 w-2 rounded-full", statusDot)} />
            <span className={cn("font-mono text-[10px] uppercase tracking-widest", statusText)}>
              {isOnline ? "ONLINE" : isChecking ? "CHECKING" : "STANDBY"}
            </span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open settings"
            onClick={() => setSettingsOpen(true)}
            className="h-9 w-9 text-muted-foreground hover:text-cyan"
          >
            <Settings className="h-5 w-5" />
          </Button>
        </div>
      </header>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

      {/* Main */}
      <main className="flex-1 pb-20">
        <Outlet />
      </main>

      {/* Bottom tab bar */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 backdrop-blur"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <ul className="grid grid-cols-5">
          {tabs.map((t) => (
            <li key={t.to}>
              <NavLink
                to={t.to}
                end={t.to === "/"}
                className={({ isActive }) =>
                  cn(
                    "flex flex-col items-center justify-center gap-1 px-1 py-2.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground transition-colors",
                    isActive && "text-cyan",
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <span
                      className={cn(
                        "rounded-md p-1.5 transition-all",
                        isActive && "bg-cyan/10 text-cyan glow-cyan-soft",
                      )}
                    >
                      <t.icon className="h-4 w-4" />
                    </span>
                    <span className="font-mono text-[9px]">{t.label}</span>
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
};
