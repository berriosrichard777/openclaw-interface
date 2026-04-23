import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/hooks/use-toast";
import { Lock, Mail, Power } from "lucide-react";

const Login = () => {
  const navigate = useNavigate();
  const [email, setEmail] = useState("operator@openclaw.local");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = "OPENCLAW CONTROL // ACCESS";
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate("/", { replace: true });
    });
  }, [navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/`,
            data: { display_name: "Richard Berrios-Irizarry", callsign: "OPERATOR_01" },
          },
        });
        if (error) throw error;
        toast({ title: "OPERATOR PROVISIONED", description: "Profile linked. Signing in..." });
        const { error: signErr } = await supabase.auth.signInWithPassword({ email, password });
        if (signErr) throw signErr;
        navigate("/", { replace: true });
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        navigate("/", { replace: true });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "AUTH FAILED";
      toast({ title: "ACCESS DENIED", description: msg, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-4">
      <div className="grid-bg pointer-events-none absolute inset-0 opacity-30" />
      <div className="relative w-full max-w-sm rounded-xl border border-border bg-surface p-6 glow-cyan-soft animate-fade-in-up">
        <div className="mb-6 text-center">
          <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-muted-foreground">
            // SECURE TERMINAL
          </p>
          <h1 className="mt-2 font-mono text-2xl font-bold tracking-widest text-cyan">OPENCLAW</h1>
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
            CONTROL :: V2.4.0
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email" className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              OPERATOR ID
            </Label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="bg-surface-2 pl-9 font-mono text-sm"
                placeholder="operator@openclaw.local"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="password" className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              PASS PHRASE
            </Label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="password"
                type="password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="bg-surface-2 pl-9 font-mono text-sm"
                placeholder="••••••••"
              />
            </div>
          </div>

          <Button
            type="submit"
            disabled={busy}
            className="w-full bg-cyan font-mono text-xs uppercase tracking-widest text-cyan-foreground hover:bg-cyan/90 glow-cyan"
          >
            <Power className="mr-2 h-4 w-4" />
            {busy ? "AUTHENTICATING..." : mode === "signin" ? "ENGAGE TERMINAL" : "PROVISION OPERATOR"}
          </Button>

          <button
            type="button"
            onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
            className="block w-full text-center font-mono text-[11px] uppercase tracking-widest text-muted-foreground hover:text-cyan"
          >
            {mode === "signin" ? "// FIRST DEPLOYMENT? PROVISION OPERATOR" : "// EXISTING OPERATOR? SIGN IN"}
          </button>
        </form>

        <p className="mt-6 text-center font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
          AUTHORIZED PERSONNEL :: RICHARD BERRIOS-IRIZARRY
        </p>
      </div>
    </div>
  );
};

export default Login;
