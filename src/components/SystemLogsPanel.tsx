import { useMemo, useState } from "react";
import { FileText, Loader2, Copy, Eraser, RefreshCw, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

type Filter = "ALL" | "ERRORS" | "WARNINGS" | "TELEGRAM" | "GATEWAY" | "BRIDGE";
type LineCount = 30 | 50 | 100;

const FILTERS: Filter[] = ["ALL", "ERRORS", "WARNINGS", "TELEGRAM", "GATEWAY", "BRIDGE"];
const COUNTS: LineCount[] = [30, 50, 100];

const ERROR_RE = /\b(error|err|fail|failed|failure|fatal|exception|critical|panic)\b/i;
const WARN_RE = /\b(warn|warning|deprecated|retry|timeout)\b/i;
const OK_RE = /\b(ok|success|succeeded|ready|online|healthy|started|connected)\b/i;

// Keys to strip from rendered JSON to avoid leaking secrets in the UI.
const SENSITIVE_KEYS = /^(authorization|auth|token|access_token|refresh_token|api_key|apikey|x-api-key|x-gateway-token|secret|password|cookie|set-cookie|bearer)$/i;

type ParsedLog = {
  raw: string;
  json: Record<string, unknown> | null;
  timestamp?: string;
  level?: string;
  module?: string;
  message?: string;
  source?: string;
};

const pick = (obj: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = obj[k];
    if (v != null && v !== "") return typeof v === "string" ? v : JSON.stringify(v);
  }
  return undefined;
};

const sanitize = (obj: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.test(k)) {
      out[k] = "••• redacted •••";
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = sanitize(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
};

const parseLine = (line: string): ParsedLog => {
  const trimmed = line.trim();
  // Try direct JSON parse
  let json: Record<string, unknown> | null = null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        json = parsed as Record<string, unknown>;
      }
    } catch {
      // Try to extract first {...} substring
      const m = trimmed.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          const parsed = JSON.parse(m[0]);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            json = parsed as Record<string, unknown>;
          }
        } catch {
          /* ignore */
        }
      }
    }
  }

  if (!json) return { raw: line, json: null };

  const safe = sanitize(json);
  return {
    raw: line,
    json: safe,
    timestamp: pick(safe, ["timestamp", "time", "ts", "@timestamp", "date"]),
    level: pick(safe, ["logLevelName", "level", "severity", "lvl"]),
    module: pick(safe, ["module", "logger", "component", "service", "name"]),
    message: pick(safe, ["message", "msg", "event", "text", "description"]),
    source: pick(safe, ["path", "source", "file", "location", "url"]),
  };
};

const levelClass = (level?: string): string => {
  if (!level) return "border-border bg-surface-2 text-muted-foreground";
  const l = level.toUpperCase();
  if (/ERROR|FATAL|CRITICAL|PANIC/.test(l)) return "border-destructive/50 bg-destructive/15 text-destructive";
  if (/WARN/.test(l)) return "border-yellow-400/40 bg-yellow-400/10 text-yellow-400";
  if (/INFO|OK|SUCCESS/.test(l)) return "border-green-neon/40 bg-green-neon/10 text-green-neon";
  if (/DEBUG|TRACE/.test(l)) return "border-cyan/40 bg-cyan/10 text-cyan";
  return "border-border bg-surface-2 text-muted-foreground";
};

const matchesFilter = (line: string, f: Filter): boolean => {
  if (f === "ALL") return true;
  if (f === "ERRORS") return ERROR_RE.test(line);
  if (f === "WARNINGS") return WARN_RE.test(line);
  if (f === "TELEGRAM") return /telegram/i.test(line);
  if (f === "GATEWAY") return /gateway/i.test(line);
  if (f === "BRIDGE") return /bridge/i.test(line);
  return true;
};

const lineClass = (line: string): string => {
  if (ERROR_RE.test(line)) return "text-destructive";
  if (WARN_RE.test(line)) return "text-yellow-400";
  if (OK_RE.test(line)) return "text-green-neon";
  return "text-foreground/85";
};

// Best-effort extraction of log lines from arbitrary edge-function payloads.
const extractLines = (raw: unknown): string[] => {
  if (raw == null) return [];
  if (typeof raw === "string") return raw.split(/\r?\n/).filter(Boolean);
  if (Array.isArray(raw)) {
    return raw.flatMap((item) => {
      if (typeof item === "string") return [item];
      if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        const ts = obj.timestamp ?? obj.time ?? obj.ts ?? "";
        const lvl = obj.level ?? obj.severity ?? "";
        const msg = obj.message ?? obj.msg ?? obj.text ?? JSON.stringify(obj);
        return [[ts, lvl ? `[${String(lvl).toUpperCase()}]` : "", msg].filter(Boolean).join(" ").trim()];
      }
      return [String(item)];
    });
  }
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of ["logs", "lines", "data", "items", "entries", "output", "stdout", "result"]) {
      if (key in obj) return extractLines(obj[key]);
    }
    return [JSON.stringify(obj, null, 2)];
  }
  return [String(raw)];
};

const SystemLogsPanel = () => {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [filter, setFilter] = useState<Filter>("ALL");
  const [count, setCount] = useState<LineCount>(50);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchLogs = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: fnErr } = await supabase.functions.invoke("openclaw-agent", {
        body: { command: `Fetch last ${count} system logs.`, action: "logs", lines: count },
      });
      if (fnErr) throw fnErr;

      const call = (data as any)?.calls?.[0];
      const payload = call?.body ?? (data as any)?.logs ?? (data as any)?.reply ?? data;
      const extracted = extractLines(payload);
      setLines(extracted.slice(-count));
      setFetchedAt(new Date().toISOString());
      if (!open) setOpen(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to fetch logs";
      setError(msg);
      toast({ title: "LOGS FETCH FAILED", description: msg, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const visible = useMemo(() => lines.filter((l) => matchesFilter(l, filter)), [lines, filter]);

  const copyLogs = async () => {
    if (visible.length === 0) {
      toast({ title: "NOTHING TO COPY", description: "No log lines visible." });
      return;
    }
    try {
      await navigator.clipboard.writeText(visible.join("\n"));
      toast({ title: "COPIED", description: `${visible.length} lines copied.` });
    } catch {
      toast({ title: "COPY FAILED", description: "Clipboard unavailable.", variant: "destructive" });
    }
  };

  const clearView = () => {
    setLines([]);
    setError(null);
    setFetchedAt(null);
    toast({ title: "VIEW CLEARED", description: "Local view only — server logs untouched." });
  };

  return (
    <div className="rounded-lg border border-border bg-surface">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-cyan" />
          <p className="font-mono text-[11px] uppercase tracking-widest">System Logs</p>
          {fetchedAt && (
            <span className="font-mono text-[10px] text-muted-foreground">
              :: {new Date(fetchedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-cyan"
        >
          {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          {open ? "HIDE" : "SHOW"}
        </button>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <Button
          onClick={fetchLogs}
          disabled={loading}
          size="sm"
          className="bg-cyan text-cyan-foreground hover:bg-cyan/90 glow-cyan-soft"
        >
          {loading ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          )}
          <span className="font-mono text-[10px] uppercase tracking-widest">
            {loading ? "FETCHING..." : "Fetch System Logs"}
          </span>
        </Button>

        {/* Line count selector */}
        <div className="flex items-center gap-1 rounded-md border border-border bg-surface-2 p-0.5">
          {COUNTS.map((c) => (
            <button
              key={c}
              onClick={() => setCount(c)}
              className={cn(
                "rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest transition-colors",
                count === c
                  ? "bg-cyan/15 text-cyan"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {c} lines
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Button
            onClick={copyLogs}
            size="sm"
            variant="outline"
            className="font-mono text-[10px] uppercase tracking-widest"
          >
            <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy Logs
          </Button>
          <Button
            onClick={clearView}
            size="sm"
            variant="outline"
            className="font-mono text-[10px] uppercase tracking-widest"
          >
            <Eraser className="mr-1.5 h-3.5 w-3.5" /> Clear View
          </Button>
        </div>
      </div>

      {/* Filter chips */}
      <div className="flex flex-wrap gap-1.5 border-b border-border/60 px-4 py-2.5">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              "rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-widest transition-colors",
              filter === f
                ? "border-cyan/50 bg-cyan/10 text-cyan glow-cyan-soft"
                : "border-border bg-surface-2 text-muted-foreground hover:text-foreground",
            )}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Output */}
      {open && (
        <div className="relative">
          <div className="scanline pointer-events-none absolute inset-0 overflow-hidden rounded-b-lg" />
          <div className="max-h-[420px] overflow-y-auto bg-black/60 px-3 py-2 scrollbar-thin">
            {error ? (
              <p className="px-2 py-3 font-mono text-[11px] text-destructive">⚠ {error}</p>
            ) : lines.length === 0 ? (
              <p className="px-2 py-6 text-center font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                ◌ NO LOGS LOADED — PRESS FETCH SYSTEM LOGS
              </p>
            ) : visible.length === 0 ? (
              <p className="px-2 py-6 text-center font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                No matching log lines
              </p>
            ) : (
              <ul className="space-y-1.5">
                {visible.map((line, i) => {
                  const p = parseLine(line);
                  const idx = String(i + 1).padStart(3, "0");

                  if (!p.json) {
                    return (
                      <li
                        key={i}
                        className="flex gap-2 rounded border border-border/40 bg-surface-2/40 px-2 py-1.5 font-mono text-[11px] leading-relaxed"
                      >
                        <span className="select-none text-muted-foreground/60">{idx}</span>
                        <span className={cn("break-words", lineClass(line))}>{line}</span>
                      </li>
                    );
                  }

                  const knownKeys = new Set([
                    "timestamp", "time", "ts", "@timestamp", "date",
                    "logLevelName", "level", "severity", "lvl",
                    "module", "logger", "component", "service", "name",
                    "message", "msg", "event", "text", "description",
                    "path", "source", "file", "location", "url",
                  ]);
                  const extras = Object.fromEntries(
                    Object.entries(p.json).filter(([k]) => !knownKeys.has(k)),
                  );
                  const hasExtras = Object.keys(extras).length > 0;

                  return (
                    <li
                      key={i}
                      className="rounded border border-border/40 bg-surface-2/40 px-2.5 py-1.5 font-mono text-[11px]"
                    >
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="select-none text-muted-foreground/60">{idx}</span>
                        {p.timestamp && (
                          <span className="text-[10px] text-muted-foreground/80">{p.timestamp}</span>
                        )}
                        {p.level && (
                          <span
                            className={cn(
                              "rounded border px-1.5 py-0 text-[9px] uppercase tracking-widest",
                              levelClass(p.level),
                            )}
                          >
                            {p.level}
                          </span>
                        )}
                        {p.module && (
                          <span className="rounded border border-cyan/30 bg-cyan/5 px-1.5 py-0 text-[9px] uppercase tracking-widest text-cyan">
                            {p.module}
                          </span>
                        )}
                      </div>
                      {p.message && (
                        <p className={cn("mt-1 break-words leading-relaxed", lineClass(p.message))}>
                          {p.message}
                        </p>
                      )}
                      {p.source && (
                        <p className="mt-0.5 truncate text-[10px] text-muted-foreground/70">
                          ↳ {p.source}
                        </p>
                      )}
                      {hasExtras && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-[9px] uppercase tracking-widest text-muted-foreground hover:text-cyan">
                            + meta ({Object.keys(extras).length})
                          </summary>
                          <pre className="mt-1 overflow-x-auto rounded bg-black/40 p-1.5 text-[10px] text-foreground/70 scrollbar-thin">
{JSON.stringify(extras, null, 2)}
                          </pre>
                        </details>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="flex items-center justify-between border-t border-border/60 bg-surface-2/50 px-3 py-1.5">
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {visible.length} / {lines.length} lines
            </span>
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              filter :: {filter}
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

export default SystemLogsPanel;
