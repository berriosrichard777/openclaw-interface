import { useEffect, useState } from "react";
import { Globe, Terminal, Folder, Eye } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

type SkillRow = {
  id: string;
  slug: string;
  label: string;
  description: string;
  icon: string | null;
  sort_order: number;
};

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  globe: Globe,
  terminal: Terminal,
  folder: Folder,
  eye: Eye,
};

const Skills = () => {
  const { user } = useAuth();
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});

  useEffect(() => {
    document.title = "OPENCLAW CONTROL // SKILLS";
    if (!user) return;
    (async () => {
      const [{ data: cat }, { data: ops }] = await Promise.all([
        supabase.from("skills").select("*").order("sort_order"),
        supabase.from("operator_skills").select("skill_id, enabled").eq("user_id", user.id),
      ]);
      setSkills((cat as SkillRow[]) ?? []);
      const map: Record<string, boolean> = {};
      ops?.forEach((o) => (map[o.skill_id] = o.enabled));
      setEnabled(map);
    })();
  }, [user]);

  const toggle = async (skillId: string, next: boolean) => {
    if (!user) return;
    setEnabled((p) => ({ ...p, [skillId]: next })); // optimistic
    const { error } = await supabase
      .from("operator_skills")
      .upsert(
        { user_id: user.id, skill_id: skillId, enabled: next, updated_at: new Date().toISOString() },
        { onConflict: "user_id,skill_id" },
      );
    if (error) {
      setEnabled((p) => ({ ...p, [skillId]: !next }));
      toast({ title: "TOGGLE FAILED", description: error.message, variant: "destructive" });
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <header>
        <p className="font-mono text-[10px] uppercase tracking-widest text-cyan">// CAPABILITIES</p>
        <h2 className="mt-1 text-xl font-bold tracking-tight">AGENT SKILLS</h2>
        <p className="font-mono text-xs text-muted-foreground">
          Toggles persist per operator and are sent with every command.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        {skills.map((s) => {
          const Icon = ICONS[s.icon ?? ""] ?? Terminal;
          const on = !!enabled[s.id];
          return (
            <div
              key={s.id}
              className={cn(
                "rounded-xl border bg-surface p-4 transition-all",
                on ? "border-cyan/40 glow-cyan-soft" : "border-border",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <span
                    className={cn(
                      "flex h-10 w-10 items-center justify-center rounded-lg border",
                      on ? "border-cyan/50 bg-cyan/10 text-cyan" : "border-border bg-surface-2 text-muted-foreground",
                    )}
                  >
                    <Icon className="h-5 w-5" />
                  </span>
                  <div className="min-w-0">
                    <p className="font-mono text-sm font-bold tracking-wide">{s.label}</p>
                    <p className="mt-1 font-mono text-[11px] text-muted-foreground">{s.description}</p>
                  </div>
                </div>
                <Switch checked={on} onCheckedChange={(v) => toggle(s.id, v)} aria-label={`Toggle ${s.label}`} />
              </div>
              <p
                className={cn(
                  "mt-3 font-mono text-[10px] uppercase tracking-widest",
                  on ? "text-green-neon" : "text-muted-foreground",
                )}
              >
                {on ? "● ENABLED" : "○ DISABLED"}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default Skills;
