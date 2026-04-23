import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

type Source = "ALL" | "SYSTEM" | "MODEL" | "SKILL" | "TERMINAL";
type Level = "INFO" | "WARN" | "ERROR" | "OK";
type Log = { id: string; source: Exclude<Source, "ALL">; level: Level; message: string; created_at: string };

const FILTERS: Source[] = ["ALL", "SYSTEM", "MODEL", "SKILL", "TERMINAL"];

const levelColor: Record<Level, string> = {
  OK: "text-green-neon",
  INFO: "text-cyan",
  WARN: "text-yellow-400",
  ERROR: "text-destructive",
};
const sourceColor: Record<Exclude<Source, "ALL">, string> = {
  SYSTEM: "text-cyan",
  MODEL: "text-purple-400",
  SKILL: "text-green-neon",
  TERMINAL: "text-orange-400",
};

const formatTime = (iso: string) => {
  const d = new Date(iso);
  return d.toISOString().split("T")[1]?.replace("Z", "").slice(0, 12) ?? iso;
};

const ActivityPage = () => {
  const { user } = useAuth();
  const [logs, setLogs] = useState<Log[]>([]);
  const [filter, setFilter] = useState<Source>("ALL");

  useEffect(() => {
    document.title = "OPENCLAW CONTROL // ACTIVITY";
    if (!user) return;
    (async () => {
      const { data } = await supabase
        .from("activity_logs")
        .select("id, source, level, message, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(500);
      setLogs((data as Log[]) ?? []);
    })();

    const channel = supabase
      .channel(`activity_logs_${user.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "activity_logs", filter: `user_id=eq.${user.id}` },
        (payload) => {
          setLogs((prev) => [payload.new as Log, ...prev].slice(0, 500));
        },
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "activity_logs", filter: `user_id=eq.${user.id}` },
        () => {
          setLogs([]);
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user]);

  const purge = async () => {
    if (!user) return;
    const { error } = await supabase.from("activity_logs").delete().eq("user_id", user.id);
    if (error) {
      toast({ title: "PURGE FAILED", description: error.message, variant: "destructive" });
      return;
    }
    setLogs([]);
    await supabase.from("activity_logs").insert({
      user_id: user.id,
      source: "SYSTEM",
      level: "WARN",
      message: "LOG STREAM PURGED BY OPERATOR.",
    });
    toast({ title: "STREAM PURGED", description: "Activity log cleared." });
  };

  const visible = filter === "ALL" ? logs : logs.filter((l) => l.source === filter);

  return (
    <div className="mx-auto flex h-[calc(100vh-3.5rem-5rem)] max-w-4xl flex-col p-4">
      <header className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-cyan">// LIVE STREAM</p>
          <h2 className="mt-1 text-xl font-bold tracking-tight">ACTIVITY TERMINAL</h2>
          <p className="font-mono text-xs text-muted-foreground">Real-time log feed (postgres_changes).</p>
        </div>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="destructive"
              size="sm"
              className="font-mono text-[10px] uppercase tracking-widest glow-red"
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> PURGE LOGS
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent className="border-destructive/40 bg-surface">
            <AlertDialogHeader>
              <AlertDialogTitle className="font-mono uppercase tracking-widest">CONFIRM PURGE</AlertDialogTitle>
              <AlertDialogDescription className="font-mono text-xs">
                This permanently erases your activity log stream. Operation cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="font-mono text-xs uppercase">Abort</AlertDialogCancel>
              <AlertDialogAction
                onClick={purge}
                className="bg-destructive font-mono text-xs uppercase tracking-widest hover:bg-destructive/90"
              >
                Purge stream
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </header>

      <div className="mb-3 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              "rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors",
              filter === f
                ? "border-cyan/50 bg-cyan/10 text-cyan glow-cyan-soft"
                : "border-border bg-surface-2 text-muted-foreground hover:text-foreground",
            )}
          >
            {f}
          </button>
        ))}
      </div>

      <div className="relative flex-1 overflow-hidden rounded-lg border border-border bg-black/60">
        <div className="scanline pointer-events-none absolute inset-0 overflow-hidden" />
        <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between border-b border-border bg-surface-2/80 px-3 py-1.5 backdrop-blur">
          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            /var/log/openclaw.stream
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">{visible.length} EVENTS</span>
        </div>
        <div className="h-full overflow-y-auto px-3 pb-3 pt-9 scrollbar-thin">
          {visible.length === 0 ? (
            <p className="mt-6 text-center font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              ◌ NO EVENTS IN STREAM
            </p>
          ) : (
            <ul className="space-y-1 font-mono text-[11px] leading-relaxed">
              {visible.map((l) => (
                <li key={l.id} className="flex flex-wrap gap-x-2 gap-y-0.5 animate-fade-in-up">
                  <span className="text-muted-foreground">{formatTime(l.created_at)}</span>
                  <span className={cn("font-bold", levelColor[l.level])}>[{l.level}]</span>
                  <span className={cn("font-bold", sourceColor[l.source])}>{l.source}</span>
                  <span className="text-muted-foreground">»</span>
                  <span className="text-foreground/90 break-words">{l.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};

export default ActivityPage;
