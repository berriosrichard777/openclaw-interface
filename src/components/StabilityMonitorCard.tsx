import { useState } from "react";
import {
  ShieldCheck,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HeartPulse,
  Cpu,
  Radio,
  Send,
  ScrollText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

type BridgeAction = "health" | "system" | "gateway-status" | "telegram-status" | "logs";

type CallResult = {
  endpoint: string;
  status: number;
  ok: boolean;
  body?: unknown;
};

type AgentResp = {
  reply?: string;
  calls?: CallResult[];
};

type Verdict = "OK" | "WARNING" | "CRITICAL" | "UNKNOWN";
type TgVerdict = "OPERATIONAL" | "PARTIAL OK" | "OK" | "WARNING" | "ERROR" | "UNKNOWN";

type Snapshot = {
  bridgeOnline: boolean;
  gateway: Verdict;
  telegram: TgVerdict;
  cpuPct: number | null;
  ramPct: number | null;
  diskPct: number | null;
  overall: Verdict;
  summary: string[];
  checkedAt: string;
  errors: string[];
};

const invokeAction = async (action: BridgeAction): Promise<AgentResp> => {
  const { data, error } = await supabase.functions.invoke("openclaw-agent", {
    body: { command: `stability ${action} probe`, action },
  });
  if (error) throw error;
  return (data ?? {}) as AgentResp;
};

// ---- Safe extractors (never expose tokens / secrets) -----------------------

const SENSITIVE_KEY = /(token|secret|authorization|api[_-]?key|password|cookie)/i;

const walk = (obj: unknown, visit: (key: string, value: unknown) => void, depth = 0) => {
  if (!obj || typeof obj !== "object" || depth > 6) return;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(k)) continue; // hard-skip sensitive keys
    visit(k, v);
    if (v && typeof v === "object") walk(v, visit, depth + 1);
  }
};

const findNumberPercent = (body: unknown, keyRe: RegExp): number | null => {
  let found: number | null = null;
  walk(body, (k, v) => {
    if (found !== null) return;
    if (!keyRe.test(k)) return;
    if (typeof v === "number" && isFinite(v)) {
      found = v > 1 && v <= 100 ? v : v <= 1 ? Math.round(v * 1000) / 10 : v;
    } else if (typeof v === "string") {
      const m = v.match(/(\d+(?:\.\d+)?)/);
      if (m) found = parseFloat(m[1]);
    }
  });
  return found === null ? null : Math.round(found * 10) / 10;
};

const extractCpu = (body: unknown) => findNumberPercent(body, /^(cpu(_|-)?(percent|usage|pct)?|cpuLoad)$/i);
const extractRam = (body: unknown) =>
  findNumberPercent(body, /^(ram|mem(ory)?)(_|-)?(percent|usage|used|pct)?$/i);
const extractDisk = (body: unknown) =>
  findNumberPercent(body, /^(disk|storage)(_|-)?(percent|usage|used|pct)?$/i);

// Parse telegram verdict from the reply text (cheap & safe).
const parseTelegramVerdict = (reply: string | undefined): TgVerdict => {
  if (!reply) return "UNKNOWN";
  const head = reply.split("\n")[0]?.toUpperCase() ?? "";
  if (head.includes("OPERATIONAL") && head.includes("PARTIAL")) return "PARTIAL OK";
  if (head.includes("OPERATIONAL")) return "OPERATIONAL";
  if (head.includes("PARTIAL OK")) return "PARTIAL OK";
  if (head.includes("ERROR")) return "ERROR";
  if (head.includes("WARNING")) return "WARNING";
  if (head.includes(":: OK")) return "OK";
  return "UNKNOWN";
};

const pctVerdict = (n: number | null): Verdict => {
  if (n === null) return "UNKNOWN";
  if (n >= 90) return "CRITICAL";
  if (n >= 75) return "WARNING";
  return "OK";
};

// ---- UI helpers ------------------------------------------------------------

const verdictColor = (v: Verdict | TgVerdict) => {
  switch (v) {
    case "OK":
    case "OPERATIONAL":
      return "text-green-neon border-green-neon/40 bg-green-neon/10";
    case "PARTIAL OK":
    case "WARNING":
      return "text-yellow-400 border-yellow-400/40 bg-yellow-400/10";
    case "ERROR":
    case "CRITICAL":
      return "text-destructive border-destructive/40 bg-destructive/10";
    default:
      return "text-muted-foreground border-border bg-surface-2";
  }
};

const VerdictPill = ({ v }: { v: Verdict | TgVerdict }) => (
  <span
    className={cn(
      "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest",
      verdictColor(v),
    )}
  >
    {v}
  </span>
);

const Tile = ({
  icon: Icon,
  label,
  value,
  verdict,
}: {
  icon: typeof Cpu;
  label: string;
  value: string;
  verdict?: Verdict | TgVerdict;
}) => (
  <div className="rounded-md border border-border/60 bg-surface-2/40 p-3">
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 text-cyan" />
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {label}
        </span>
      </div>
      {verdict && <VerdictPill v={verdict} />}
    </div>
    <p className="mt-2 font-mono text-sm font-semibold text-foreground">{value}</p>
  </div>
);

// ---- Component -------------------------------------------------------------

const StabilityMonitorCard = () => {
  const [running, setRunning] = useState(false);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runCheck = async () => {
    setRunning(true);
    setError(null);
    try {
      const [health, system, gateway, telegram, logs] = await Promise.all([
        invokeAction("health").catch((e) => ({ _err: e } as any)),
        invokeAction("system").catch((e) => ({ _err: e } as any)),
        invokeAction("gateway-status").catch((e) => ({ _err: e } as any)),
        invokeAction("telegram-status").catch((e) => ({ _err: e } as any)),
        invokeAction("logs").catch((e) => ({ _err: e } as any)),
      ]);

      const errs: string[] = [];
      const okCall = (r: any) => Boolean(r?.calls?.every?.((c: CallResult) => c.ok));

      const bridgeOnline = okCall(health);
      if (!bridgeOnline) errs.push("Bridge probe failed");

      const systemOk = okCall(system);
      if (!systemOk) errs.push("System probe failed");

      const gatewayHttpOk = okCall(gateway);
      const gateway200 = (gateway?.calls?.[0] as CallResult | undefined)?.status === 200;
      const gatewayVerdict: Verdict = gatewayHttpOk && gateway200 ? "OK" : gateway?.calls?.length ? "WARNING" : "CRITICAL";
      if (gatewayVerdict === "CRITICAL") errs.push("Gateway not reachable");

      const tgVerdict = parseTelegramVerdict(telegram?.reply);

      // Resource extraction from the system response body.
      const sysBody = (system?.calls?.[0] as CallResult | undefined)?.body;
      const cpu = extractCpu(sysBody);
      const ram = extractRam(sysBody);
      const disk = extractDisk(sysBody);

      // Look for "error" markers in recent logs (without exposing content).
      const logsBody = (logs?.calls?.[0] as CallResult | undefined)?.body;
      const logsText = typeof logsBody === "string" ? logsBody : JSON.stringify(logsBody ?? "");
      const criticalInLogs = /\b(fatal|panic|crash)\b/i.test(logsText);
      const warningInLogs = /\b(warn|warning|degraded)\b/i.test(logsText);
      if (criticalInLogs) errs.push("Critical markers in recent logs");

      const resourceVerdicts = [pctVerdict(cpu), pctVerdict(ram), pctVerdict(disk)];
      const anyResourceCritical = resourceVerdicts.includes("CRITICAL");
      const anyResourceWarn = resourceVerdicts.includes("WARNING");

      // Overall verdict logic
      let overall: Verdict = "OK";
      if (!bridgeOnline || !systemOk || gatewayVerdict === "CRITICAL" || tgVerdict === "ERROR" || anyResourceCritical) {
        overall = "CRITICAL";
      } else if (
        gatewayVerdict === "WARNING" ||
        tgVerdict === "PARTIAL OK" ||
        tgVerdict === "WARNING" ||
        warningInLogs ||
        anyResourceWarn
      ) {
        overall = "WARNING";
      }

      const summary: string[] = [
        bridgeOnline ? "Bridge OK" : "Bridge offline",
        gatewayVerdict === "OK" ? "Gateway OK" : `Gateway ${gatewayVerdict}`,
        `Telegram ${tgVerdict === "UNKNOWN" ? "unknown" : tgVerdict}`,
        criticalInLogs
          ? "Critical errors detected in logs"
          : warningInLogs
            ? "Warnings present in recent logs"
            : "No critical errors found",
        anyResourceCritical
          ? "System resources HIGH"
          : anyResourceWarn
            ? "System resources elevated"
            : "System resources normal",
      ];

      setSnap({
        bridgeOnline,
        gateway: gatewayVerdict,
        telegram: tgVerdict,
        cpuPct: cpu,
        ramPct: ram,
        diskPct: disk,
        overall,
        summary,
        checkedAt: new Date().toISOString(),
        errors: errs,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Stability check failed");
    } finally {
      setRunning(false);
    }
  };

  const OverallIcon =
    snap?.overall === "OK" ? CheckCircle2 : snap?.overall === "WARNING" ? AlertTriangle : XCircle;

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-cyan" />
          <p className="font-mono text-[11px] uppercase tracking-widest">System Stability Monitor</p>
        </div>
        {snap && (
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest",
              verdictColor(snap.overall),
            )}
          >
            <OverallIcon className="h-3 w-3" />
            {snap.overall === "OK" ? "HEALTHY" : snap.overall}
          </span>
        )}
      </div>

      <p className="mt-1 font-mono text-[10px] text-muted-foreground">
        Aggregated read-only probe :: <span className="text-cyan">health</span> +{" "}
        <span className="text-cyan">system</span> + <span className="text-cyan">gateway</span> +{" "}
        <span className="text-cyan">telegram</span> + <span className="text-cyan">logs</span>
      </p>

      <Button
        onClick={runCheck}
        disabled={running}
        className="mt-3 w-full bg-cyan text-cyan-foreground hover:bg-cyan/90 glow-cyan-soft"
      >
        {running ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            <span className="font-mono text-[11px] uppercase tracking-widest">RUNNING STABILITY CHECK...</span>
          </>
        ) : (
          <span className="font-mono text-[11px] uppercase tracking-widest">Run Stability Check</span>
        )}
      </Button>

      {error && (
        <p className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-2 font-mono text-[11px] text-destructive">
          {error}
        </p>
      )}

      {snap && (
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Tile
              icon={HeartPulse}
              label="Bridge"
              value={snap.bridgeOnline ? "ONLINE" : "OFFLINE"}
              verdict={snap.bridgeOnline ? "OK" : "CRITICAL"}
            />
            <Tile icon={Radio} label="Gateway" value={snap.gateway} verdict={snap.gateway} />
            <Tile icon={Send} label="Telegram" value={snap.telegram} verdict={snap.telegram} />
            <Tile
              icon={ScrollText}
              label="Last Check"
              value={new Date(snap.checkedAt).toLocaleTimeString()}
            />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <Tile
              icon={Cpu}
              label="CPU"
              value={snap.cpuPct === null ? "unknown" : `${snap.cpuPct}%`}
              verdict={pctVerdict(snap.cpuPct)}
            />
            <Tile
              icon={Cpu}
              label="RAM"
              value={snap.ramPct === null ? "unknown" : `${snap.ramPct}%`}
              verdict={pctVerdict(snap.ramPct)}
            />
            <Tile
              icon={Cpu}
              label="Disk"
              value={snap.diskPct === null ? "unknown" : `${snap.diskPct}%`}
              verdict={pctVerdict(snap.diskPct)}
            />
          </div>

          <div className="rounded-md border border-border/60 bg-surface-2/40 p-3">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Summary
            </p>
            <ul className="mt-2 space-y-1">
              {snap.summary.map((s, i) => (
                <li key={i} className="flex items-start gap-2 font-mono text-[11px] text-foreground">
                  <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-cyan" />
                  {s}
                </li>
              ))}
            </ul>
            {snap.errors.length > 0 && (
              <p className="mt-2 font-mono text-[10px] text-destructive">
                {snap.errors.length} issue{snap.errors.length > 1 ? "s" : ""} detected — review System Logs.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default StabilityMonitorCard;
