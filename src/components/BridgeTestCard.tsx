import { useState } from "react";
import { PlugZap, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

type StepResult = {
  endpoint: string;
  status: number;
  ok: boolean;
  body?: unknown;
};

type TestState = {
  online: boolean;
  steps: { label: string; result: StepResult }[];
  latencyMs: number;
  checkedAt: string;
  error?: string;
};

const Row = ({ label, value, accent }: { label: string; value: string; accent?: "ok" | "err" | "info" }) => (
  <div className="flex items-baseline justify-between gap-3 border-b border-border/50 py-1.5 last:border-0">
    <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</span>
    <span
      className={cn(
        "font-mono text-xs",
        accent === "ok" && "text-green-neon",
        accent === "err" && "text-destructive",
        accent === "info" && "text-cyan",
        !accent && "text-foreground",
      )}
    >
      {value}
    </span>
  </div>
);

const BridgeTestCard = () => {
  const [running, setRunning] = useState(false);
  const [state, setState] = useState<TestState | null>(null);

  const runOne = async (action: "health" | "system") => {
    const { data, error } = await supabase.functions.invoke("openclaw-agent", {
      body: { command: `bridge ${action} probe`, action },
    });
    if (error) throw error;
    const call = data?.calls?.[0] as StepResult | undefined;
    if (!call) throw new Error("Edge Function returned no call result");
    return call;
  };

  const runTest = async () => {
    setRunning(true);
    const startedAt = performance.now();
    try {
      const health = await runOne("health");
      const system = await runOne("system");
      const latencyMs = Math.round(performance.now() - startedAt);
      const online = health.ok && system.ok;
      setState({
        online,
        steps: [
          { label: "HEALTH", result: health },
          { label: "SYSTEM", result: system },
        ],
        latencyMs,
        checkedAt: new Date().toISOString(),
        error: online ? undefined : `One or more probes returned non-2xx`,
      });
    } catch (e) {
      const latencyMs = Math.round(performance.now() - startedAt);
      setState({
        online: false,
        steps: [],
        latencyMs,
        checkedAt: new Date().toISOString(),
        error: e instanceof Error ? e.message : "Unknown error",
      });
    } finally {
      setRunning(false);
    }
  };

  const StatusBadge = () => {
    if (running) {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-cyan/40 bg-cyan/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-cyan">
          <Loader2 className="h-3 w-3 animate-spin" /> CHECKING
        </span>
      );
    }
    if (!state) {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          IDLE
        </span>
      );
    }
    return state.online ? (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-green-neon/40 bg-green-neon/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-green-neon">
        <CheckCircle2 className="h-3 w-3" /> ONLINE
      </span>
    ) : (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-destructive">
        <XCircle className="h-3 w-3" /> OFFLINE
      </span>
    );
  };

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <PlugZap className="h-4 w-4 text-cyan" />
          <p className="font-mono text-[11px] uppercase tracking-widest">Bridge Connection Probe</p>
        </div>
        <StatusBadge />
      </div>

      <p className="mt-1 font-mono text-[10px] text-muted-foreground">
        Sequential probe :: <span className="text-cyan">/api/openclaw/health</span> →{" "}
        <span className="text-cyan">/api/openclaw/system</span>
      </p>

      <Button
        onClick={runTest}
        disabled={running}
        className="mt-3 w-full bg-cyan text-cyan-foreground hover:bg-cyan/90 glow-cyan-soft"
      >
        {running ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            <span className="font-mono text-[11px] uppercase tracking-widest">PROBING...</span>
          </>
        ) : (
          <span className="font-mono text-[11px] uppercase tracking-widest">Test Bridge Connection</span>
        )}
      </Button>

      {state && (
        <div className="mt-4 space-y-2">
          <div className="rounded-md border border-border/60 bg-surface-2/40 p-3">
            <Row
              label="Bridge"
              value={state.online ? "ONLINE" : "OFFLINE"}
              accent={state.online ? "ok" : "err"}
            />
            <Row label="Total Latency" value={`${state.latencyMs} ms`} accent="info" />
            <Row label="Last Checked" value={new Date(state.checkedAt).toLocaleString()} />
            {state.error && <Row label="Error" value={state.error} accent="err" />}
          </div>

          {state.steps.length > 0 && (
            <div className="rounded-md border border-border/60 bg-surface-2/40 p-3">
              {state.steps.map((s) => (
                <div key={s.label} className="border-b border-border/50 py-1.5 last:border-0">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                      {s.label}
                    </span>
                    <span
                      className={cn(
                        "font-mono text-xs",
                        s.result.ok ? "text-green-neon" : "text-destructive",
                      )}
                    >
                      HTTP {s.result.status} {s.result.ok ? "✓" : "✖"}
                    </span>
                  </div>
                  <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{s.result.endpoint}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default BridgeTestCard;
