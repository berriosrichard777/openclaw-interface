import { useState } from "react";
import { ChevronDown, ChevronUp, Activity, Radio, Cpu, MemoryStick, HardDrive, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

export type SystemMetrics = {
  bridgeOk: boolean | null;
  gatewayOk: boolean | null;
  cpu: number | null;
  ram: number | null;
  disk: number | null;
  lastChecked: string | null;
  raw?: unknown;
};

const dot = (ok: boolean | null) =>
  ok === null ? "bg-muted-foreground/50" : ok ? "bg-green-neon pulse-dot" : "bg-destructive";

const pct = (n: number | null) =>
  n === null || Number.isNaN(n) ? "—" : `${Math.round(n)}%`;

const pctClass = (n: number | null) => {
  if (n === null) return "text-muted-foreground";
  if (n >= 90) return "text-destructive";
  if (n >= 75) return "text-yellow-400";
  return "text-green-neon";
};

const StatusBar = ({ metrics }: { metrics: SystemMetrics }) => {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-b border-border bg-surface/80 backdrop-blur">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2">
        <div className="flex items-center gap-1.5">
          <span className={cn("h-2 w-2 rounded-full", dot(metrics.bridgeOk))} />
          <Activity className="h-3 w-3 text-muted-foreground" />
          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Bridge
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={cn("h-2 w-2 rounded-full", dot(metrics.gatewayOk))} />
          <Radio className="h-3 w-3 text-muted-foreground" />
          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Gateway
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Cpu className="h-3 w-3 text-muted-foreground" />
          <span className={cn("font-mono text-[10px] uppercase tracking-widest", pctClass(metrics.cpu))}>
            CPU {pct(metrics.cpu)}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <MemoryStick className="h-3 w-3 text-muted-foreground" />
          <span className={cn("font-mono text-[10px] uppercase tracking-widest", pctClass(metrics.ram))}>
            RAM {pct(metrics.ram)}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <HardDrive className="h-3 w-3 text-muted-foreground" />
          <span className={cn("font-mono text-[10px] uppercase tracking-widest", pctClass(metrics.disk))}>
            DISK {pct(metrics.disk)}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            <Clock className="h-3 w-3" />
            {metrics.lastChecked
              ? new Date(metrics.lastChecked).toLocaleTimeString()
              : "—"}
          </div>
          <button
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-muted-foreground hover:border-cyan/40 hover:text-cyan"
          >
            {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {open ? "Less" : "More"}
          </button>
        </div>
      </div>
      {open && (
        <div className="mx-auto max-w-3xl border-t border-border/60 px-4 py-2">
          <pre className="max-h-48 overflow-auto rounded bg-black/50 p-2 font-mono text-[10px] text-foreground/80 scrollbar-thin">
{metrics.raw ? JSON.stringify(metrics.raw, null, 2) : "No metrics captured yet. Run a quick action."}
          </pre>
        </div>
      )}
    </div>
  );
};

export default StatusBar;
