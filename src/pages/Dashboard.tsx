import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Activity, Cpu, MessageSquare, Wand2, ArrowRight } from "lucide-react";
import { useOperator } from "@/hooks/useOperator";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import BridgeTestCard from "@/components/BridgeTestCard";
import StabilityMonitorCard from "@/components/StabilityMonitorCard";
import AlertCenterCard from "@/components/AlertCenterCard";

const Stat = ({
  label,
  value,
  hint,
  accent = "cyan",
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: "cyan" | "green";
}) => (
  <div className="rounded-lg border border-border bg-surface p-4">
    <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</p>
    <p
      className={`mt-2 font-mono text-2xl font-bold ${accent === "cyan" ? "text-cyan" : "text-green-neon"}`}
    >
      {value}
    </p>
    {hint && <p className="mt-1 font-mono text-[10px] text-muted-foreground">{hint}</p>}
  </div>
);

const Dashboard = () => {
  const { user } = useAuth();
  const { profile, activeModel } = useOperator();
  const [skillsOn, setSkillsOn] = useState(0);
  const [logsCount, setLogsCount] = useState(0);

  useEffect(() => {
    document.title = "OPENCLAW CONTROL // DASHBOARD";
    if (!user) return;
    (async () => {
      const [{ count: logs }, { data: skills }] = await Promise.all([
        supabase
          .from("activity_logs")
          .select("id", { count: "exact", head: true })
          .eq("user_id", user.id),
        supabase.from("operator_skills").select("enabled").eq("user_id", user.id).eq("enabled", true),
      ]);
      setLogsCount(logs ?? 0);
      setSkillsOn(skills?.length ?? 0);
    })();
  }, [user]);

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-4">
      <section className="relative overflow-hidden rounded-xl border border-cyan/30 bg-surface p-5 glow-cyan-soft">
        <div className="grid-bg pointer-events-none absolute inset-0 opacity-15" />
        <div className="relative">
          <p className="font-mono text-[10px] uppercase tracking-widest text-cyan">// MISSION CONTROL</p>
          <h2 className="mt-2 text-2xl font-bold leading-tight">
            Welcome back, <span className="text-cyan">{profile?.callsign ?? "OPERATOR_01"}</span>.
          </h2>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {profile?.display_name ?? "Richard Berrios-Irizarry"} :: AGENT BRIDGE STAND-BY
          </p>
          <Button asChild className="mt-4 bg-cyan text-cyan-foreground hover:bg-cyan/90 glow-cyan">
            <Link to="/chat" className="font-mono text-xs uppercase tracking-widest">
              <MessageSquare className="mr-2 h-4 w-4" /> OPEN COMMAND BRIDGE
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Agent" value="ONLINE" accent="green" hint="OPENCLAW_AGENT_V2.4" />
        <Stat label="Active Model" value={activeModel?.name?.split(" ")[1] ?? "—"} hint={activeModel?.latency ?? "—"} />
        <Stat label="Skills" value={String(skillsOn)} hint="enabled" accent="green" />
        <Stat label="Log Events" value={String(logsCount)} hint="lifetime" />
      </section>

      <BridgeTestCard />

      <StabilityMonitorCard />

      <section className="grid gap-3 sm:grid-cols-3">
        <Link
          to="/models"
          className="group rounded-lg border border-border bg-surface p-4 transition-colors hover:border-cyan/40 hover:glow-cyan-soft"
        >
          <Cpu className="h-5 w-5 text-cyan" />
          <p className="mt-3 font-mono text-sm font-semibold">NEURAL ARCHITECTURES</p>
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">Switch active reasoning core.</p>
        </Link>
        <Link
          to="/skills"
          className="group rounded-lg border border-border bg-surface p-4 transition-colors hover:border-cyan/40 hover:glow-cyan-soft"
        >
          <Wand2 className="h-5 w-5 text-cyan" />
          <p className="mt-3 font-mono text-sm font-semibold">AGENT SKILLS</p>
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">Toggle WEB_SEARCH, PYTHON, more.</p>
        </Link>
        <Link
          to="/activity"
          className="group rounded-lg border border-border bg-surface p-4 transition-colors hover:border-cyan/40 hover:glow-cyan-soft"
        >
          <Activity className="h-5 w-5 text-cyan" />
          <p className="mt-3 font-mono text-sm font-semibold">ACTIVITY FEED</p>
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">Real-time terminal log stream.</p>
        </Link>
      </section>
    </div>
  );
};

export default Dashboard;
