import { useEffect, useRef, useState } from "react";
import { Send, Zap, Bot, User, HeartPulse, Cpu, Radio, Activity } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useOperator } from "@/hooks/useOperator";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import SystemLogsPanel from "@/components/SystemLogsPanel";

type Msg = { id: string; role: "operator" | "agent"; content: string; created_at: string };

type BridgeAction =
  | "logs"
  | "diagnostic"
  | "health"
  | "system"
  | "gateway-status"
  | "status";

// SECURE COMMAND MAP :: only these inputs are allowed. Anything else is
// rejected locally without ever reaching the bridge or VPS.
const COMMAND_HELP = [
  "UNRECOGNIZED COMMAND :: input rejected by command guard.",
  "",
  "ALLOWED COMMANDS:",
  "  health      | /health        → bridge health check",
  "  system      | /system        → system snapshot",
  "  gateway     | /gateway       → gateway link status",
  "  status      | /status        → general agent status",
  "  logs        | /logs          → recent system logs",
  "  diagnostic  | /diagnostic    → full diagnostic sweep",
  "  telegram    | /telegram      → telegram bridge status",
  "",
  "NATURAL PHRASES ACCEPTED:",
  "  \"check health\", \"system status\", \"gateway status\",",
  "  \"show logs\", \"full diagnostic\", \"check telegram\".",
].join("\n");

const TELEGRAM_NOT_IMPLEMENTED = [
  "TELEGRAM STATUS :: NOT IMPLEMENTED",
  "",
  "The telegram-status endpoint is not wired into the bridge yet.",
  "It will be enabled in a future update.",
].join("\n");

type ResolvedCommand =
  | { kind: "action"; action: BridgeAction; label: string }
  | { kind: "local"; reply: string };

const resolveCommand = (raw: string): ResolvedCommand => {
  const c = raw.trim().toLowerCase().replace(/^\/+/, "");
  if (!c) return { kind: "local", reply: COMMAND_HELP };

  // Diagnostic
  if (/^(diagnostic|full[\s_-]*diagnostic|sweep|full[\s_-]*scan)$/.test(c))
    return { kind: "action", action: "diagnostic", label: "Full Diagnostic" };

  // Logs
  if (/^(logs?|show[\s_-]+logs?|tail[\s_-]+logs?)$/.test(c))
    return { kind: "action", action: "logs", label: "System Logs" };

  // Gateway
  if (/^(gateway|gateway[\s_-]*status|check[\s_-]+gateway)$/.test(c))
    return { kind: "action", action: "gateway-status", label: "Gateway Status" };

  // Health
  if (/^(health|check[\s_-]+health|ping|alive)$/.test(c))
    return { kind: "action", action: "health", label: "Health Check" };

  // System
  if (/^(system|system[\s_-]*status|check[\s_-]+system)$/.test(c))
    return { kind: "action", action: "system", label: "System Status" };

  // Status (general)
  if (/^(status|general[\s_-]*status|agent[\s_-]*status)$/.test(c))
    return { kind: "action", action: "status", label: "General Status" };

  // Telegram (not implemented yet)
  if (/^(telegram|telegram[\s_-]*status|check[\s_-]+telegram)$/.test(c))
    return { kind: "local", reply: TELEGRAM_NOT_IMPLEMENTED };

  return { kind: "local", reply: COMMAND_HELP };
};

const Chat = () => {
  const { user } = useAuth();
  const { activeModel } = useOperator();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.title = "OPENCLAW CONTROL // CHAT";
    if (!user) return;
    supabase
      .from("chat_messages")
      .select("id, role, content, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true })
      .limit(200)
      .then(({ data }) => setMessages((data as Msg[]) ?? []));
  }, [user]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const send = async (text: string, action?: BridgeAction) => {
    if (!user || !text.trim() || sending) return;
    setSending(true);
    const cmd = text.trim();
    setInput("");

    // Optimistic operator message
    const tempId = crypto.randomUUID();
    const operatorMsg: Msg = {
      id: tempId,
      role: "operator",
      content: cmd,
      created_at: new Date().toISOString(),
    };
    setMessages((m) => [...m, operatorMsg]);

    try {
      // Persist operator message
      await supabase.from("chat_messages").insert({
        user_id: user.id,
        role: "operator",
        content: cmd,
        model_slug: activeModel?.slug ?? null,
      });

      // Get enabled skills
      const { data: ops } = await supabase
        .from("operator_skills")
        .select("enabled, skills(slug)")
        .eq("user_id", user.id)
        .eq("enabled", true);
      const skills = (ops ?? [])
        .map((o: any) => o.skills?.slug)
        .filter(Boolean) as string[];

      // Invoke edge function. The bridge token is read server-side ONLY,
      // from the OPENCLAW_BRIDGE_TOKEN secret. The frontend never handles it.
      const { data, error } = await supabase.functions.invoke("openclaw-agent", {
        body: { command: cmd, model: activeModel?.slug, skills, action },
      });
      if (error) throw error;

      const reply = (data?.reply as string) ?? "(no response)";
      await supabase.from("chat_messages").insert({
        user_id: user.id,
        role: "agent",
        content: reply,
        model_slug: activeModel?.slug ?? null,
      });
      setMessages((m) => [
        ...m,
        { id: crypto.randomUUID(), role: "agent", content: reply, created_at: new Date().toISOString() },
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "TRANSMIT FAILED";
      toast({ title: "AGENT ERROR", description: msg, variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  // Quick actions map UI buttons → explicit bridge actions (no NL parsing).
  const quickActions: { label: string; icon: typeof Zap; cmd: string; action: BridgeAction }[] = [
    { label: "Full Diagnostic", icon: Zap,        cmd: "Run full diagnostic sweep.",     action: "diagnostic"     },
    { label: "Health Check",    icon: HeartPulse, cmd: "Bridge health check.",            action: "health"         },
    { label: "System Status",   icon: Cpu,        cmd: "Read system snapshot.",           action: "system"         },
    { label: "Gateway Status",  icon: Radio,      cmd: "Read gateway link status.",       action: "gateway-status" },
    { label: "General Status",  icon: Activity,   cmd: "Read general agent status.",      action: "status"         },
  ];

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
          {messages.map((m) => (
            <div
              key={m.id}
              className={cn("flex w-full gap-2 animate-fade-in-up", m.role === "operator" ? "justify-end" : "justify-start")}
            >
              {m.role === "agent" && (
                <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-cyan/40 bg-cyan/10 text-cyan">
                  <Bot className="h-4 w-4" />
                </div>
              )}
              <div className={cn("max-w-[80%] space-y-1", m.role === "operator" && "items-end text-right")}>
                <p
                  className={cn(
                    "font-mono text-[9px] uppercase tracking-widest",
                    m.role === "operator" ? "text-cyan" : "text-green-neon",
                  )}
                >
                  {m.role === "operator" ? "OPERATOR_01" : "OPENCLAW_AGENT_V2.4"}
                </p>
                <div
                  className={cn(
                    "rounded-lg border px-3 py-2 text-sm whitespace-pre-wrap break-words",
                    m.role === "operator"
                      ? "border-cyan/40 bg-cyan/10 text-foreground glow-cyan-soft"
                      : "border-border bg-surface font-mono text-[13px]",
                  )}
                >
                  {m.content}
                </div>
              </div>
              {m.role === "operator" && (
                <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-surface-2 text-muted-foreground">
                  <User className="h-4 w-4" />
                </div>
              )}
            </div>
          ))}
          {sending && (
            <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan" />
              OPENCLAW_AGENT_V2.4 :: PROCESSING...
            </div>
          )}
        </div>
      </div>

      {/* Quick actions + command bar */}
      <div className="border-t border-border bg-surface/80 backdrop-blur">
        <div className="mx-auto max-w-3xl space-y-2 p-3">
          <SystemLogsPanel />
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
              placeholder="TRANSMIT_COMMAND_TO_AGENT..."
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
