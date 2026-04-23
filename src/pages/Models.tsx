import { useEffect, useState } from "react";
import { Check, Cpu, Zap } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useOperator, type ModelRow } from "@/hooks/useOperator";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const Spec = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-center justify-between rounded-md border border-border bg-surface-2/60 px-3 py-2">
    <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</span>
    <span className="font-mono text-xs font-semibold text-foreground">{value}</span>
  </div>
);

const Models = () => {
  const { user } = useAuth();
  const { activeModel, refresh } = useOperator();
  const [models, setModels] = useState<ModelRow[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    document.title = "OPENCLAW CONTROL // MODELS";
    supabase
      .from("models")
      .select("*")
      .order("sort_order")
      .then(({ data }) => setModels((data as ModelRow[]) ?? []));
  }, []);

  const setActive = async (m: ModelRow) => {
    if (!user || activeModel?.id === m.id) return;
    setBusyId(m.id);
    const { error } = await supabase
      .from("operator_settings")
      .upsert({ user_id: user.id, active_model_id: m.id, updated_at: new Date().toISOString() });
    if (error) {
      toast({ title: "SWITCH FAILED", description: error.message, variant: "destructive" });
    } else {
      await supabase.from("activity_logs").insert({
        user_id: user.id,
        source: "MODEL",
        level: "OK",
        message: `Active architecture set :: ${m.name}`,
      });
      toast({ title: "ARCHITECTURE ENGAGED", description: m.name });
      await refresh();
    }
    setBusyId(null);
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <header>
        <p className="font-mono text-[10px] uppercase tracking-widest text-cyan">// CATALOG</p>
        <h2 className="mt-1 text-xl font-bold tracking-tight">NEURAL ARCHITECTURES</h2>
        <p className="font-mono text-xs text-muted-foreground">Select the reasoning core for OPENCLAW_AGENT_V2.4.</p>
      </header>

      <div className="space-y-3">
        {models.map((m) => {
          const isActive = activeModel?.id === m.id;
          const isFlash = m.slug.includes("flash");
          return (
            <button
              key={m.id}
              onClick={() => setActive(m)}
              disabled={isActive || busyId === m.id}
              className={cn(
                "block w-full rounded-xl border bg-surface p-4 text-left transition-all",
                isActive ? "border-cyan/50 glow-cyan-soft" : "border-border hover:border-cyan/30",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <span
                    className={cn(
                      "flex h-10 w-10 items-center justify-center rounded-lg border",
                      isActive ? "border-cyan/50 bg-cyan/10 text-cyan" : "border-border bg-surface-2 text-muted-foreground",
                    )}
                  >
                    {isFlash ? <Zap className="h-5 w-5" /> : <Cpu className="h-5 w-5" />}
                  </span>
                  <div>
                    <p className="font-mono text-sm font-bold tracking-wide">{m.name}</p>
                    <p className="mt-1 font-mono text-[11px] text-muted-foreground">{m.description}</p>
                  </div>
                </div>
                {isActive ? (
                  <span className="flex items-center gap-1 rounded-full border border-green-neon/40 bg-green-neon/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-green-neon">
                    <Check className="h-3 w-3" /> ACTIVE
                  </span>
                ) : (
                  <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    STAND-BY
                  </span>
                )}
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2">
                <Spec label="Latency" value={m.latency} />
                <Spec label="Context" value={m.context} />
                <Spec label="Multimodal" value={m.multimodal} />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default Models;
