import { useEffect, useMemo, useRef, useState } from "react";
import { Send, Zap, Bot, User, HeartPulse, Cpu, Radio, Activity, Bell, FileText, History, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useOperator } from "@/hooks/useOperator";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import SystemLogsPanel from "@/components/SystemLogsPanel";
import StatusBar, { type SystemMetrics } from "@/components/chat/StatusBar";
import AgentCard, { type Verdict } from "@/components/chat/AgentCard";

type Msg = {
  id: string;
  role: "operator" | "agent";
  content: string;
  created_at: string;
  verdict?: Verdict | null;
  rawCalls?: unknown;
  suggestions?: string[];
};

type BridgeAction =
  | "logs"
  | "diagnostic"
  | "health"
  | "system"
  | "gateway-status"
  | "status"
  | "telegram-status"
  | "stability"
  | "alerts"
  | "uptime"
  | "network"
  | "ports"
  | "containers"
  | "memory"
  | "disk";

const FORBIDDEN_PATTERNS: RegExp[] = [
  /\bdelete\b/i, /\bremove\b/i, /\brm\s+-/i, /\bdrop\b/i, /\bpurge\b/i,
  /\bstop\s+(server|service|bot|gateway|telegram|docker|bridge)\b/i,
  /\brestart\b/i, /\breboot\b/i, /\bshutdown\b/i, /\bkill\b/i,
  /\bchange\s+(token|secret|password|config)\b/i,
  /\bedit\s+(config|env|secret|token)\b/i,
  /\bdocker\s+(restart|stop|start|kill|rm|remove|exec|run|build|push|pull|compose|logs|cp|commit|tag|login|logout|system|prune|network|volume|swarm|service|stack|secret|config)\b/i,
  /\bdocker[-_]?compose\b/i,
  /\bkubectl\b/i, /\bsystemctl\b/i, /\bsudo\b/i,
  /\bshell\b/i, /\bbash\b/i, /\bsh\s+-c\b/i,
  /\bcloudflare\b/i, /\bdns\b/i, /\bfirewall\b/i,
  /\b(show|expose|reveal|print|leak|dump)\s+(the\s+)?(token|secret|password|api[_-]?key|env|credential)/i,
  /\bgive me (the )?(token|secret|password|api[_-]?key)\b/i,
];

const FORBIDDEN_REPLY =
  "REQUEST BLOCKED ::\n  This action is not allowed from Command Chat. " +
  "Only safe read-only diagnostics are enabled.";

const HELP_REPLY = [
  "I couldn't map that to a safe diagnostic intent.",
  "",
  "Try natural phrases like:",
  "  • 'check health'   · 'system status'   · 'gateway status'",
  "  • 'show logs'      · 'full diagnostic' · 'check telegram'",
  "  • 'stability'      · 'alerts'",
].join("\n");

type ResolvedCommand =
  | { kind: "action"; action: BridgeAction; label: string }
  | { kind: "local"; reply: string };

const resolveCommand = (raw: string): ResolvedCommand => {
  const c = raw.trim().toLowerCase().replace(/^\/+/, "");
  if (!c) return { kind: "local", reply: HELP_REPLY };
  if (FORBIDDEN_PATTERNS.some((re) => re.test(c)))
    return { kind: "local", reply: FORBIDDEN_REPLY };

  if (/telegram|por\s*qu[eé]\s+telegram|revisa\s+telegram/.test(c))
    return { kind: "action", action: "telegram-status", label: "Telegram Status" };
  if (/\balerts?\b|alert\s*center|qu[eé]\s+problemas|warnings?\s+activos/.test(c))
    return { kind: "action", action: "alerts", label: "Alert Center" };
  if (/stability|estado\s+general|todo\s+est[aá]\s+bien|system\s+stability/.test(c))
    return { kind: "action", action: "stability", label: "System Stability" };
  if (/diagnostic|sweep|full[\s_-]*scan|diagn[oó]stico|haz\s+un\s+diagn/.test(c))
    return { kind: "action", action: "diagnostic", label: "Full Diagnostic" };
  if (/\blogs?\b|tail|errores?\s+recientes|warnings?\s+recientes|mu[eé]strame\s+logs/.test(c))
    return { kind: "action", action: "logs", label: "System Logs" };
  if (/gateway/.test(c))
    return { kind: "action", action: "gateway-status", label: "Gateway Status" };
  if (/\bhealth\b|ping|alive|est[aá]\s+vivo|bridge\s+online|check\s+bridge|revisa\s+health/.test(c))
    return { kind: "action", action: "health", label: "Health Check" };
  if (/\buptime\b|how\s+long|system\s+running|tiempo\s+activo|cu[aá]ndo\s+inici[oó]|cuando\s+inicio/.test(c))
    return { kind: "action", action: "uptime", label: "Uptime" };
  if (/\bnetwork\b|interfaces?|estado\s+de\s+red|conexi[oó]n|ip\s+address|connectivity/.test(c))
    return { kind: "action", action: "network", label: "Network" };
  if (/\bports?\b|listening\s+ports|open\s+ports|puertos(\s+abiertos)?/.test(c))
    return { kind: "action", action: "ports", label: "Ports" };
  if (/\bcontainers?\b|docker\s+ps|docker\s+status|running\s+containers|contenedores(\s+activos)?/.test(c))
    return { kind: "action", action: "containers", label: "Containers" };
  if (/\bmemory\b|memoria|memory\s+usage|ram\s+detalle|uso\s+de\s+memoria/.test(c))
    return { kind: "action", action: "memory", label: "Memory" };
  if (/\bdisk\b|disco|disk\s+usage|almacenamiento|espacio\s+en\s+disco/.test(c))
    return { kind: "action", action: "disk", label: "Disk" };
  if (/\bsystem\b|cpu|ram|mem(ory)?|recursos|estado\s+del\s+sistema/.test(c))
    return { kind: "action", action: "system", label: "System Status" };
  if (/\bstatus\b|state|report|estado/.test(c))
    return { kind: "action", action: "status", label: "General Status" };

  return { kind: "local", reply: HELP_REPLY };
};

const parseVerdict = (text: string): Verdict | null => {
  const m = text.match(/^Status:\s*(OK|Warning|Critical|Blocked)\b/m);
  return m ? (m[1] as Verdict) : null;
};

// Map an action to follow-up suggestion commands.
const SUGGESTION_MAP: Record<string, string[]> = {
  health: ["system", "gateway", "stability"],
  system: ["memory", "disk", "uptime"],
  "telegram-status": ["logs", "alerts", "health"],
  logs: ["alerts", "diagnostic", "system"],
  "gateway-status": ["health", "system", "stability"],
  status: ["health", "system", "alerts"],
  diagnostic: ["alerts", "stability", "logs"],
  stability: ["alerts", "logs", "diagnostic"],
  alerts: ["logs", "diagnostic", "stability"],
  uptime: ["system", "network", "containers"],
  network: ["ports", "system", "health"],
  ports: ["network", "containers", "system"],
  containers: ["ports", "memory", "system"],
  memory: ["system", "disk", "uptime"],
  disk: ["system", "memory", "uptime"],
};

const getSuggestions = (action?: BridgeAction | null): string[] => {
  if (!action) return [];
  return SUGGESTION_MAP[action] ?? [];
};

// ---- Metrics extraction from edge-function `calls` payload ---------------

const findEndpoint = (calls: any[], suffix: string) =>
  calls.find((c) => typeof c?.endpoint === "string" && c.endpoint.includes(suffix));

const toPct = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) {
    if (v <= 1) return v * 100;
    return v;
  }
  if (typeof v === "string") {
    const n = parseFloat(v.replace("%", ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const deepFind = (obj: any, keys: string[]): unknown => {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of Object.keys(obj)) {
    if (keys.some((target) => k.toLowerCase() === target.toLowerCase())) return obj[k];
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const found = deepFind(v, keys);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

const extractMetrics = (calls: any[]): Partial<SystemMetrics> => {
  const out: Partial<SystemMetrics> = {};
  if (!Array.isArray(calls) || calls.length === 0) return out;

  const health = findEndpoint(calls, "/health");
  const gw = findEndpoint(calls, "/gateway-status");
  const sys = findEndpoint(calls, "/system");

  if (health) out.bridgeOk = health.ok === true;
  if (gw) out.gatewayOk = gw.ok === true;

  if (sys?.body) {
    const cpu = deepFind(sys.body, ["cpu", "cpu_percent", "cpuUsage", "cpu_usage"]);
    const ram = deepFind(sys.body, ["ram", "memory", "mem", "memory_percent", "ram_percent"]);
    const disk = deepFind(sys.body, ["disk", "disk_percent", "disk_usage"]);

    // memory may itself be an object {percent: ...}
    const cpuPct =
      toPct(typeof cpu === "object" && cpu !== null ? deepFind(cpu, ["percent", "usage", "used"]) : cpu);
    const ramPct =
      toPct(typeof ram === "object" && ram !== null ? deepFind(ram, ["percent", "usage", "used"]) : ram);
    const diskPct =
      toPct(typeof disk === "object" && disk !== null ? deepFind(disk, ["percent", "usage", "used"]) : disk);

    if (cpuPct !== null) out.cpu = cpuPct;
    if (ramPct !== null) out.ram = ramPct;
    if (diskPct !== null) out.disk = diskPct;
  }

  return out;
};

const Chat = () => {
  const { user } = useAuth();
  const { activeModel } = useOperator();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState<SystemMetrics>({
    bridgeOk: null,
    gatewayOk: null,
    cpu: null,
    ram: null,
    disk: null,
    lastChecked: null,
    raw: null,
  });
  const [logsOpen, setLogsOpen] = useState(false);
  const [logsLastChecked, setLogsLastChecked] = useState<string | null>(null);

  useEffect(() => {
    document.title = "OPENCLAW CONTROL // CHAT";
    if (!user) return;
    supabase
      .from("chat_messages")
      .select("id, role, content, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true })
      .limit(200)
      .then(({ data }) => {
        const rows = (data ?? []) as Msg[];
        setMessages(
          rows.map((r) => ({
            ...r,
            verdict: r.role === "agent" ? parseVerdict(r.content) : null,
          })),
        );
      });
  }, [user]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const send = async (text: string, action?: BridgeAction) => {
    if (!user || !text.trim() || sending) return;
    const cmd = text.trim();
    if (action === "logs") {
      setLogsOpen(true);
      setLogsLastChecked(new Date().toISOString());
    }

    let resolvedAction: BridgeAction | undefined = action;
    let localReply: string | null = null;
    if (!action) {
      const resolved = resolveCommand(cmd);
      if (resolved.kind === "action") {
        resolvedAction = resolved.action;
      } else {
        localReply = resolved.reply;
      }
    }

    setSending(true);
    setInput("");

    const tempId = crypto.randomUUID();
    const operatorMsg: Msg = {
      id: tempId,
      role: "operator",
      content: cmd,
      created_at: new Date().toISOString(),
    };
    setMessages((m) => [...m, operatorMsg]);

    try {
      await supabase.from("chat_messages").insert({
        user_id: user.id,
        role: "operator",
        content: cmd,
        model_slug: activeModel?.slug ?? null,
      });

      if (localReply !== null) {
        await supabase.from("chat_messages").insert({
          user_id: user.id,
          role: "agent",
          content: localReply,
          model_slug: activeModel?.slug ?? null,
        });
        setMessages((m) => [
          ...m,
          {
            id: crypto.randomUUID(),
            role: "agent",
            content: localReply!,
            created_at: new Date().toISOString(),
            verdict: parseVerdict(localReply!) ?? "Blocked",
            suggestions: ["health", "system", "alerts"],
          },
        ]);
        return;
      }

      const { data: ops } = await supabase
        .from("operator_skills")
        .select("enabled, skills(slug)")
        .eq("user_id", user.id)
        .eq("enabled", true);
      const skills = (ops ?? [])
        .map((o: any) => o.skills?.slug)
        .filter(Boolean) as string[];

      const { data, error } = await supabase.functions.invoke("openclaw-agent", {
        body: { command: cmd, model: activeModel?.slug, skills, action: resolvedAction },
      });
      if (error) throw error;

      const reply = (data?.reply as string) ?? "(no response)";
      const verdict = ((data?.verdict as Verdict | null) ?? parseVerdict(reply)) as Verdict | null;
      const calls = (data?.calls as any[]) ?? [];
      const usedAction = (data?.action as BridgeAction | null) ?? resolvedAction ?? null;

      // Update status bar from any returned calls (only updates on commands).
      const partial = extractMetrics(calls);
      if (Object.keys(partial).length > 0 || calls.length > 0) {
        setMetrics((prev) => ({
          bridgeOk: partial.bridgeOk ?? prev.bridgeOk,
          gatewayOk: partial.gatewayOk ?? prev.gatewayOk,
          cpu: partial.cpu ?? prev.cpu,
          ram: partial.ram ?? prev.ram,
          disk: partial.disk ?? prev.disk,
          lastChecked: new Date().toISOString(),
          raw: calls.length > 0 ? calls : prev.raw,
        }));
      }

      await supabase.from("chat_messages").insert({
        user_id: user.id,
        role: "agent",
        content: reply,
        model_slug: activeModel?.slug ?? null,
      });
      setMessages((m) => [
        ...m,
        {
          id: crypto.randomUUID(),
          role: "agent",
          content: reply,
          created_at: new Date().toISOString(),
          verdict,
          rawCalls: calls.length > 0 ? calls : undefined,
          suggestions: getSuggestions(usedAction),
        },
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "TRANSMIT FAILED";
      toast({ title: "AGENT ERROR", description: msg, variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  const quickActions: { label: string; icon: typeof Zap; cmd: string; action: BridgeAction }[] = [
    { label: "Full Diagnostic", icon: Zap,        cmd: "Run full diagnostic sweep.",     action: "diagnostic"     },
    { label: "Health Check",    icon: HeartPulse, cmd: "Bridge health check.",            action: "health"         },
    { label: "System Status",   icon: Cpu,        cmd: "Read system snapshot.",           action: "system"         },
    { label: "Gateway Status",  icon: Radio,      cmd: "Read gateway link status.",       action: "gateway-status" },
    { label: "Logs",            icon: FileText,   cmd: "Show recent system logs.",        action: "logs"           },
    { label: "Alerts",          icon: Bell,       cmd: "Show active alerts.",             action: "alerts"         },
    { label: "General Status",  icon: Activity,   cmd: "Read general agent status.",      action: "status"         },
  ];

  // Recent commands history (last 5 unique).
  const recentCommands = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (let i = messages.length - 1; i >= 0 && out.length < 5; i--) {
      const m = messages[i];
      if (m.role !== "operator") continue;
      const c = m.content.trim();
      if (!c || seen.has(c.toLowerCase())) continue;
      seen.add(c.toLowerCase());
      out.push(c);
    }
    return out;
  }, [messages]);

  return (
    <div className="flex h-[calc(100vh-3.5rem-5rem)] flex-col">
      {/* Channel header */}
      <div className="flex items-center justify-between border-b border-border bg-surface/60 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-green-neon pulse-dot" />
          <span className="font-mono text-[11px] uppercase tracking-widest text-green-neon">
            CHANNEL :: AGENT
          </span>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {activeModel?.name ?? "—"}
        </span>
      </div>

      {/* Pinned status bar */}
      <StatusBar metrics={metrics} />

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto max-w-3xl space-y-4 p-4">
          {messages.length === 0 && (
            <div className="rounded-lg border border-dashed border-border bg-surface/40 p-6 text-center">
              <Bot className="mx-auto h-8 w-8 text-cyan" />
              <p className="mt-3 font-mono text-xs text-muted-foreground">
                BRIDGE OPEN. AWAITING TRANSMISSION FROM OPERATOR_01.
              </p>
            </div>
          )}
          {messages.map((m) => {
            if (m.role === "operator") {
              return (
                <div key={m.id} className="flex w-full justify-end gap-2 animate-fade-in-up">
                  <div className="max-w-[80%] space-y-1 text-right">
                    <p className="font-mono text-[9px] uppercase tracking-widest text-cyan">
                      OPERATOR_01
                    </p>
                    <div className="rounded-lg border border-cyan/40 bg-cyan/10 px-3 py-2 text-sm text-foreground glow-cyan-soft whitespace-pre-wrap break-words">
                      {m.content}
                    </div>
                  </div>
                  <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-surface-2 text-muted-foreground">
                    <User className="h-4 w-4" />
                  </div>
                </div>
              );
            }
            return (
              <div key={m.id} className="w-full animate-fade-in-up">
                <AgentCard
                  content={m.content}
                  verdict={m.verdict ?? null}
                  timestamp={m.created_at}
                  rawCalls={m.rawCalls}
                  suggestions={m.suggestions}
                  onSuggestion={(s) => send(s)}
                />
              </div>
            );
          })}
          {sending && (
            <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan" />
              OPENCLAW_AGENT_V2.5 :: PROCESSING...
            </div>
          )}
        </div>
      </div>

      {/* Quick actions + command bar */}
      <div className="border-t border-border bg-surface/80 backdrop-blur">
        <div className="mx-auto max-w-3xl space-y-2 p-3">
          <div className="rounded border border-border/60 bg-surface-2/50">
            <button
              type="button"
              onClick={() => {
                setLogsOpen((v) => {
                  if (!v) setLogsLastChecked(new Date().toISOString());
                  return !v;
                });
              }}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-cyan"
            >
              <FileText className="h-3 w-3" />
              <span>System Logs</span>
              <span className="text-muted-foreground/60">·</span>
              <span className="text-muted-foreground/80">
                {logsLastChecked ? new Date(logsLastChecked).toLocaleTimeString() : "—"}
              </span>
              <span className="ml-auto flex items-center gap-1 text-cyan/80">
                {logsOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                {logsOpen ? "Hide" : "Show"}
              </span>
            </button>
            {logsOpen && (
              <div className="border-t border-border/60 p-2">
                <SystemLogsPanel />
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {quickActions.map((q) => (
              <button
                key={q.label}
                onClick={() => send(q.cmd, q.action)}
                disabled={sending}
                className="flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground transition-colors hover:border-cyan/40 hover:text-cyan disabled:opacity-50"
              >
                <q.icon className="h-3 w-3" />
                {q.label}
              </button>
            ))}
          </div>
          {recentCommands.length > 0 && (
            <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-thin">
              <History className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="shrink-0 font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
                Recent ::
              </span>
              {recentCommands.map((c, i) => (
                <button
                  key={`${c}-${i}`}
                  onClick={() => send(c)}
                  disabled={sending}
                  title={c}
                  className="shrink-0 truncate rounded border border-border/60 bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-cyan/40 hover:text-cyan disabled:opacity-50"
                  style={{ maxWidth: "180px" }}
                >
                  {c}
                </button>
              ))}
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 focus-within:border-cyan/50 focus-within:glow-cyan-soft"
          >
            <span className="font-mono text-xs text-cyan">{">"}</span>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="ASK NATURALLY :: 'check health', 'cpu ram disk', 'todo está bien?', 'alerts'…"
              disabled={sending}
              className="flex-1 bg-transparent font-mono text-sm outline-none placeholder:font-mono placeholder:text-[11px] placeholder:uppercase placeholder:tracking-widest placeholder:text-muted-foreground"
            />
            <Button
              type="submit"
              size="icon"
              disabled={sending || !input.trim()}
              className="h-8 w-8 bg-cyan text-cyan-foreground hover:bg-cyan/90 glow-cyan"
            >
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
};

export default Chat;
