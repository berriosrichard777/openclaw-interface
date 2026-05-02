import { useEffect, useRef, useState } from "react";
import { Send, Bot, User, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";

type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

type AgentStatus = "online" | "idle" | "offline";

const STORAGE_KEY = "richops-chat-history-v1";
const MODEL_LABEL = "MiniMax-M2.7";

const WELCOME: Msg = {
  id: "welcome",
  role: "assistant",
  content:
    "Hola, soy **RichOps**. Pregúntame por el estado de OpenClaw — health, system, gateway, telegram, logs, alerts, stability, uptime, ports, containers, memory, disk — y consulto el bridge en vivo. Acciones destructivas siguen bloqueadas.",
  created_at: new Date().toISOString(),
};

const formatTime = (iso: string) => {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
};

const Talk = () => {
  const [messages, setMessages] = useState<Msg[]>(() => {
    if (typeof window === "undefined") return [WELCOME];
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return [WELCOME];
      const parsed = JSON.parse(raw) as Msg[];
      return Array.isArray(parsed) && parsed.length > 0 ? parsed : [WELCOME];
    } catch {
      return [WELCOME];
    }
  });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<AgentStatus>("online");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-50)));
    } catch {
      /* noop */
    }
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    setStatus("idle");

    const userMsg: Msg = {
      id: `u-${Date.now()}`,
      role: "user",
      content: text,
      created_at: new Date().toISOString(),
    };
    const next = [...messages, userMsg];
    setMessages(next);

    try {
      const history = next
        .filter((m) => m.id !== "welcome")
        .map((m) => ({ role: m.role, content: m.content }));
      const { data, error } = await supabase.functions.invoke("richops-chat", {
        body: { messages: history },
      });
      if (error) throw error;
      const reply = (data as { reply?: string; error?: string })?.reply
        ?? (data as { error?: string })?.error
        ?? "(sin respuesta)";
      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          content: reply,
          created_at: new Date().toISOString(),
        },
      ]);
      setStatus("online");
    } catch (e) {
      setStatus("offline");
      toast({
        title: "RichOps no disponible",
        description: String((e as Error).message ?? e),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const statusDot =
    status === "online" ? "bg-green-neon pulse-dot"
    : status === "idle" ? "bg-cyan animate-pulse"
    : "bg-muted-foreground";
  const statusText =
    status === "online" ? "text-green-neon"
    : status === "idle" ? "text-cyan"
    : "text-muted-foreground";

  return (
    <div className="flex h-[calc(100vh-3.5rem-4rem)] flex-col bg-background">
      {/* Header */}
      <header className="border-b border-border bg-surface-2/50 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="relative flex h-10 w-10 items-center justify-center rounded-full border border-cyan/40 bg-surface-2 glow-cyan-soft">
            <Sparkles className="h-5 w-5 text-cyan" />
            <span className={cn("absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border border-background", statusDot)} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="font-mono text-sm font-semibold text-cyan">RichOps</h1>
              <span className="rounded-full border border-cyan/30 bg-cyan/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest text-cyan">
                {MODEL_LABEL}
              </span>
            </div>
            <p className={cn("font-mono text-[10px] uppercase tracking-widest", statusText)}>
              {status === "online" ? "Online" : status === "idle" ? "Thinking…" : "Offline"}
            </p>
          </div>
        </div>
      </header>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-4 scrollbar-thin">
        <div className="mx-auto flex max-w-2xl flex-col gap-3">
          {messages.map((m) => {
            const isUser = m.role === "user";
            return (
              <div
                key={m.id}
                className={cn("flex items-end gap-2", isUser ? "justify-end" : "justify-start")}
              >
                {!isUser && (
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-cyan/30 bg-surface-2">
                    <Bot className="h-3.5 w-3.5 text-cyan" />
                  </div>
                )}
                <div
                  className={cn(
                    "max-w-[78%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed shadow-sm",
                    isUser
                      ? "rounded-br-sm border border-green-neon/30 bg-green-neon/10 text-foreground"
                      : "rounded-bl-sm border border-cyan/20 bg-surface-2 text-foreground",
                  )}
                >
                  <p className="whitespace-pre-wrap break-words font-sans">{m.content}</p>
                  <p
                    className={cn(
                      "mt-1 font-mono text-[9px] uppercase tracking-widest",
                      isUser ? "text-green-neon/70 text-right" : "text-muted-foreground",
                    )}
                  >
                    {formatTime(m.created_at)}
                  </p>
                </div>
                {isUser && (
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-green-neon/30 bg-surface-2">
                    <User className="h-3.5 w-3.5 text-green-neon" />
                  </div>
                )}
              </div>
            );
          })}
          {busy && (
            <div className="flex items-center gap-2 px-2 font-mono text-[10px] uppercase tracking-widest text-cyan">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-cyan" />
              RichOps escribiendo…
            </div>
          )}
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-border bg-surface-2/40 p-3">
        <div className="mx-auto flex max-w-2xl items-center gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder="Message RichOps..."
            disabled={busy}
            className={cn(
              "flex-1 rounded-full border border-border bg-background px-4 py-2.5 font-mono text-sm",
              "placeholder:text-muted-foreground/60",
              "focus:border-cyan focus:outline-none focus:ring-1 focus:ring-cyan/40",
              "disabled:opacity-60",
            )}
          />
          <Button
            onClick={send}
            disabled={busy || !input.trim()}
            size="icon"
            className="h-10 w-10 shrink-0 rounded-full bg-cyan text-background hover:bg-cyan/90 glow-cyan-soft"
            aria-label="Send"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
        <p className="mx-auto mt-2 max-w-2xl text-center font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
          Read-only · Bridge live context · Destructive actions blocked
        </p>
      </div>
    </div>
  );
};

export default Talk;
