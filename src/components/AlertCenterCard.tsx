import { useState } from "react";
import {
  Bell,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

type BridgeAction = "health" | "system" | "gateway-status" | "telegram-status" | "logs";

type CallResult = { endpoint: string; status: number; ok: boolean; body?: unknown };
type AgentResp = { reply?: string; calls?: CallResult[] };

type Severity = "Critical" | "Warning" | "Info";

type Alert = {
  id: string;
  severity: Severity;
  title: string;
  explanation: string;
  action: string;
};

const SENSITIVE_KEY = /(token|secret|authorization|api[_-]?key|password|cookie)/i;

const walk = (obj: unknown, visit: (key: string, value: unknown) => void, depth = 0) => {
  if (!obj || typeof obj !== "object" || depth > 6) return;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(k)) continue;
    visit(k, v);
    if (v && typeof v === "object") walk(v, visit, depth + 1);
  }
};

const toNum = (v: unknown): number | null => {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "string") {
    const m = v.match(/-?\d+(?:\.\d+)?/);
    if (m) return parseFloat(m[0]);
  }
  return null;
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

const extractCpu = (body: unknown) =>
  findNumberPercent(body, /^(cpu(_|-)?(percent|usage|pct)?|cpuLoad)$/i);
const extractDisk = (body: unknown) =>
  findNumberPercent(body, /^(disk|storage)(_|-)?(percent|usage|used|pct)?$/i);

const extractRam = (body: unknown): number | null => {
  if (!body || typeof body !== "object") return null;
  let percent: number | null = null;
  let used: number | null = null;
  let total: number | null = null;
  walk(body, (k, v) => {
    const key = k.toLowerCase();
    const isMemScope =
      /(^|_)(ram|mem(ory)?)(_|$)/.test(key) || ["memory", "mem", "ram"].includes(key);
    if (isMemScope && v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const p = toNum(obj.percent ?? obj.pct ?? obj.usage_percent ?? obj.usagePercent);
      const u = toNum(obj.used ?? obj.used_bytes ?? obj.usedBytes);
      const t = toNum(obj.total ?? obj.total_bytes ?? obj.totalBytes);
      if (percent === null && p !== null) percent = p;
      if (used === null && u !== null) used = u;
      if (total === null && t !== null) total = t;
    }
    if (percent === null && /^(ram|mem(ory)?)(_|-)?(percent|pct|usage_percent)$/i.test(k)) {
      const n = toNum(v);
      if (n !== null) percent = n;
    }
    if (used === null && /^(ram|mem(ory)?)(_|-)?(used|used_bytes)$/i.test(k)) {
      const n = toNum(v);
      if (n !== null) used = n;
    }
    if (total === null && /^(ram|mem(ory)?)(_|-)?(total|total_bytes)$/i.test(k)) {
      const n = toNum(v);
      if (n !== null) total = n;
    }
  });
  if (percent !== null) {
    const p = percent <= 1 && percent >= 0 ? percent * 100 : percent;
    if (p >= 0 && p <= 100) return Math.round(p * 10) / 10;
  }
  if (used !== null && total !== null && total > 0) {
    const p = (used / total) * 100;
    if (p >= 0 && p <= 100) return Math.round(p * 10) / 10;
  }
  return null;
};

const invokeAction = async (action: BridgeAction): Promise<AgentResp> => {
  const { data, error } = await supabase.functions.invoke("openclaw-agent", {
    body: { command: `alert-center ${action}`, action },
  });
  if (error) throw error;
  return (data ?? {}) as AgentResp;
};

const sevStyles = (s: Severity) => {
  switch (s) {
    case "Critical":
      return "border-destructive/40 bg-destructive/10 text-destructive";
    case "Warning":
      return "border-yellow-400/40 bg-yellow-400/10 text-yellow-400";
    default:
      return "border-cyan/40 bg-cyan/10 text-cyan";
  }
};

const SevIcon = ({ s }: { s: Severity }) => {
  if (s === "Critical") return <XCircle className="h-4 w-4" />;
  if (s === "Warning") return <AlertTriangle className="h-4 w-4" />;
  return <Info className="h-4 w-4" />;
};

const AlertCenterCard = () => {
  const [running, setRunning] = useState(false);
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);

  const buildAlerts = async () => {
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

      const okCall = (r: any) => Boolean(r?.calls?.every?.((c: CallResult) => c.ok));
      const out: Alert[] = [];

      // Bridge offline
      if (!okCall(health)) {
        out.push({
          id: "bridge-offline",
          severity: "Critical",
          title: "Bridge offline",
          explanation: "Health probe to OpenClaw bridge failed.",
          action: "Verify bridge service availability and retry probe.",
        });
      }

      // Gateway failure
      const gateway200 = (gateway?.calls?.[0] as CallResult | undefined)?.status === 200;
      if (!okCall(gateway) || !gateway200) {
        out.push({
          id: "gateway-failure",
          severity: !okCall(gateway) ? "Critical" : "Warning",
          title: "Gateway failure",
          explanation: "OpenClaw gateway did not respond with HTTP 200.",
          action: "Check gateway runtime and review recent gateway logs.",
        });
      }

      // Telegram verdict — be strict so a "Partial OK" reply never trips Critical.
      const tgRaw = telegram?.reply ?? "";
      const tgHead = tgRaw.split("\n")[0]?.toUpperCase() ?? "";
      const tgUpper = tgRaw.toUpperCase();
      const tgCallsOk = okCall(telegram);

      const tgOperational = tgHead.includes("OPERATIONAL") || tgHead.includes(":: OK");
      const tgPartial = tgHead.includes("PARTIAL OK") || tgUpper.includes("PARTIAL OK");
      const tgSendOk = /TELEGRAM\s+SENDMESSAGE\s+OK/i.test(tgRaw);

      // Configured / bot username detection (case-insensitive, simple match)
      const tgConfiguredFalse = /CONFIGURED\s*[:=]\s*FALSE/i.test(tgRaw);
      const tgConfiguredTrue = /CONFIGURED\s*[:=]\s*TRUE/i.test(tgRaw);
      const tgHasBotUsername = /BOT\s*USERNAME\s*[:=]\s*\S+/i.test(tgRaw) &&
        !/BOT\s*USERNAME\s*[:=]\s*(none|null|n\/a|-)\s*$/im.test(tgRaw);

      // Real telegram error markers (avoid matching the literal label "Telegram Status: ERROR" only,
      // and never treat OPERATIONAL/PARTIAL OK as error).
      const tgRunningFalse = /RUNNING\s*[:=]\s*FALSE/i.test(tgRaw);
      const tgExplicitErrorState =
        tgHead.includes("ERROR") ||
        tgHead.includes("FAIL") ||
        /\b(telegram[^.\n]{0,40}(failed|failure|unreachable|timeout))\b/i.test(tgRaw);
      const tgLogsHasError = /\btelegram\b[^.\n]{0,80}\b(error|failed|failure|exception)\b/i.test(
        typeof (logs?.calls?.[0] as CallResult | undefined)?.body === "string"
          ? ((logs?.calls?.[0] as CallResult).body as string)
          : JSON.stringify((logs?.calls?.[0] as CallResult | undefined)?.body ?? ""),
      );

      // Critical only when truly broken — and never when sendMessage is succeeding
      // or the diagnostic explicitly says Operational/Partial OK.
      const tgCriticalCandidate =
        !tgCallsOk ||
        tgConfiguredFalse ||
        (tgConfiguredTrue && !tgHasBotUsername) ||
        tgExplicitErrorState ||
        tgLogsHasError;

      const tgCritical =
        tgCriticalCandidate && !tgSendOk && !tgPartial && !tgOperational;

      if (tgCritical) {
        out.push({
          id: "telegram-error",
          severity: "Critical",
          title: "Telegram error",
          explanation: "Telegram diagnostic reports a failure state (configured/bot/health).",
          action: "Review Telegram Diagnostic and System Logs → Telegram.",
        });
      } else if (tgPartial || (tgRunningFalse && tgSendOk)) {
        out.push({
          id: "telegram-partial",
          severity: "Warning",
          title: "Telegram Partial OK",
          explanation: "Telegram can send messages, but OpenClaw reports running=false.",
          action: "Monitor Telegram logs or review plugin runtime.",
        });
      } else if (tgRunningFalse && !tgOperational) {
        out.push({
          id: "telegram-runtime-warning",
          severity: "Warning",
          title: "Telegram runtime warning",
          explanation: "Telegram runtime reports running=false in status payload.",
          action: "Review plugin/runtime status; sendMessage may still succeed.",
        });
      }

      // Logs analysis (no content exposure). Use strict signal matching to
      // avoid counting benign mentions of the word "error" (e.g. "error: null",
      // "no error", "No critical errors found", explanatory copy, etc.).
      const logsBody = (logs?.calls?.[0] as CallResult | undefined)?.body;
      const rawLogsText =
        typeof logsBody === "string" ? logsBody : JSON.stringify(logsBody ?? "");

      // Strip known benign signals before scanning.
      let scrubbedLogs = rawLogsText
        .replace(/telegram\s+sendMessage\s+ok/gi, "")
        .replace(/would\s+evict\s+active\s+session;\s*skipping\s+enforcement/gi, "");

      // Remove benign "error: null / none / unknown / false / 0 / []" style fields
      // in JSON or plain text, so they never trip the error scan.
      const benignErrorPatterns: RegExp[] = [
        /"[^"]*error[^"]*"\s*:\s*(null|false|0|""|\[\]|\{\})/gi,
        /\b(last[_-]?)?error[_-]?(name|code|message|reason)?\s*[:=]\s*(null|none|n\/a|unknown|false|0|"")/gi,
        /\bno\s+error(s)?\b/gi,
        /\bno\s+critical\s+errors?\s+found\b/gi,
        /\b0\s+errors?\b/gi,
        /\berror[_-]?count\s*[:=]\s*0\b/gi,
      ];
      for (const re of benignErrorPatterns) {
        scrubbedLogs = scrubbedLogs.replace(re, "");
      }

      // Real error signals only.
      const realErrorSignals: RegExp[] = [
        /"logLevelName"\s*:\s*"ERROR"/i,
        /\blogLevelName\s*[:=]\s*"?ERROR"?/i,
        /"level"\s*:\s*"error"/i,
        /\blevel\s*[:=]\s*"?error"?\b/i,
        /"status"\s*:\s*"error"/i,
        /\bstatus\s*[:=]\s*"?error"?\b/i,
        /\bfailed\b/i,
        /\bexception\b/i,
        /\bfatal\b/i,
        /\bpanic\b/i,
        /\bcrash(ed)?\b/i,
        /\bconnection\s+refused\b/i,
        /\btimeout\b/i,
        /\bHTTP\/?\s*1\.[01]\s+5\d{2}\b/i,
        /"status(Code)?"\s*:\s*5\d{2}\b/i,
        /\bstatus(Code)?\s*[:=]\s*5\d{2}\b/i,
      ];
      const hasErrors = realErrorSignals.some((re) => re.test(scrubbedLogs));

      // Real warning signals only.
      const realWarningSignals: RegExp[] = [
        /"logLevelName"\s*:\s*"WARN(ING)?"/i,
        /\blogLevelName\s*[:=]\s*"?WARN(ING)?"?/i,
        /"level"\s*:\s*"warn(ing)?"/i,
        /\blevel\s*[:=]\s*"?warn(ing)?"?\b/i,
        /\bdegraded\b/i,
      ];
      const hasWarnings = realWarningSignals.some((re) => re.test(scrubbedLogs));

      // Avoid double-counting: only emit "Recent errors found" if we found a real
      // error marker AND we didn't already raise a Telegram-specific Critical.
      if (hasErrors && !tgCritical) {
        out.push({
          id: "recent-errors",
          severity: "Critical",
          title: "Recent errors found",
          explanation: "Recent logs contain error-level entries.",
          action: "Review System Logs → Errors.",
        });
      }
      if (hasWarnings) {
        out.push({
          id: "recent-warnings",
          severity: "Warning",
          title: "Recent warnings found",
          explanation: "Recent logs contain warning-level entries.",
          action: "Review System Logs → Warnings.",
        });
      }

      // Resources
      const sysBody = (system?.calls?.[0] as CallResult | undefined)?.body;
      const cpu = extractCpu(sysBody);
      const ram = extractRam(sysBody);
      const disk = extractDisk(sysBody);

      if (cpu !== null && cpu >= 90) {
        out.push({
          id: "cpu-high",
          severity: "Critical",
          title: "CPU high",
          explanation: `CPU usage at ${cpu}%.`,
          action: "Investigate processes consuming CPU on the bridge host.",
        });
      } else if (cpu !== null && cpu >= 75) {
        out.push({
          id: "cpu-elevated",
          severity: "Warning",
          title: "CPU elevated",
          explanation: `CPU usage at ${cpu}%.`,
          action: "Monitor CPU; consider reducing concurrent workloads.",
        });
      }

      if (disk !== null && disk >= 90) {
        out.push({
          id: "disk-high",
          severity: "Critical",
          title: "Disk high",
          explanation: `Disk usage at ${disk}%.`,
          action: "Free disk space or rotate logs on the bridge host.",
        });
      } else if (disk !== null && disk >= 75) {
        out.push({
          id: "disk-elevated",
          severity: "Warning",
          title: "Disk elevated",
          explanation: `Disk usage at ${disk}%.`,
          action: "Plan cleanup of logs or unused data.",
        });
      }

      if (ram === null) {
        out.push({
          id: "ram-unknown",
          severity: "Info",
          title: "RAM unknown",
          explanation: "RAM usage could not be calculated from system endpoint.",
          action:
            "Check system endpoint format later; CPU and Disk are evaluated separately.",
        });
      } else if (ram >= 90) {
        out.push({
          id: "ram-high",
          severity: "Critical",
          title: "RAM high",
          explanation: `RAM usage at ${ram}%.`,
          action: "Investigate memory pressure on the bridge host.",
        });
      } else if (ram >= 75) {
        out.push({
          id: "ram-elevated",
          severity: "Warning",
          title: "RAM elevated",
          explanation: `RAM usage at ${ram}%.`,
          action: "Monitor RAM; restart memory-heavy plugins if needed.",
        });
      }

      // Sort by severity
      const order: Record<Severity, number> = { Critical: 0, Warning: 1, Info: 2 };
      out.sort((a, b) => order[a.severity] - order[b.severity]);

      setAlerts(out);
      setCheckedAt(new Date().toISOString());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Alert refresh failed");
    } finally {
      setRunning(false);
    }
  };

  const counts = alerts
    ? alerts.reduce(
        (acc, a) => {
          acc[a.severity]++;
          return acc;
        },
        { Critical: 0, Warning: 0, Info: 0 } as Record<Severity, number>,
      )
    : null;

  const overallEmpty = alerts && alerts.length === 0;

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Bell className="h-4 w-4 text-cyan" />
          <p className="font-mono text-[11px] uppercase tracking-widest">Alert Center</p>
        </div>
        {counts && (
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest",
                sevStyles("Critical"),
              )}
            >
              {counts.Critical} CRIT
            </span>
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest",
                sevStyles("Warning"),
              )}
            >
              {counts.Warning} WARN
            </span>
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest",
                sevStyles("Info"),
              )}
            >
              {counts.Info} INFO
            </span>
          </div>
        )}
      </div>

      <p className="mt-1 font-mono text-[10px] text-muted-foreground">
        Aggregated read-only alerts derived from bridge probes &amp; recent logs.
      </p>

      <Button
        onClick={buildAlerts}
        disabled={running}
        className="mt-3 w-full bg-cyan text-cyan-foreground hover:bg-cyan/90 glow-cyan-soft"
      >
        {running ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            <span className="font-mono text-[11px] uppercase tracking-widest">
              REFRESHING ALERTS...
            </span>
          </>
        ) : (
          <span className="font-mono text-[11px] uppercase tracking-widest">Refresh Alerts</span>
        )}
      </Button>

      {error && (
        <p className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-2 font-mono text-[11px] text-destructive">
          {error}
        </p>
      )}

      {alerts && (
        <div className="mt-4 space-y-2">
          {overallEmpty && (
            <div className="flex items-center gap-2 rounded-md border border-green-neon/40 bg-green-neon/10 p-3 text-green-neon">
              <CheckCircle2 className="h-4 w-4" />
              <p className="font-mono text-[11px]">
                No active alerts. System looks stable.
              </p>
            </div>
          )}

          {alerts.map((a) => (
            <div
              key={a.id}
              className={cn("rounded-md border p-3", sevStyles(a.severity))}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <SevIcon s={a.severity} />
                  <p className="font-mono text-[12px] font-semibold">{a.title}</p>
                </div>
                <span className="font-mono text-[10px] uppercase tracking-widest opacity-80">
                  {a.severity}
                </span>
              </div>
              <p className="mt-1.5 font-mono text-[11px] text-foreground/90">
                {a.explanation}
              </p>
              <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                <span className="uppercase tracking-widest">Action:</span> {a.action}
              </p>
            </div>
          ))}

          {checkedAt && (
            <p className="pt-1 font-mono text-[10px] text-muted-foreground">
              Last refreshed :: {new Date(checkedAt).toLocaleTimeString()}
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default AlertCenterCard;
