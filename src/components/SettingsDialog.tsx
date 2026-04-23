import { useEffect, useState } from "react";
import { Eye, EyeOff, KeyRound, Save, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useGatewayToken } from "@/hooks/useGatewayToken";
import { useBridgeStatus } from "@/hooks/useBridgeStatus";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const SettingsDialog = ({ open, onOpenChange }: SettingsDialogProps) => {
  const { token, setToken, clearToken, hasToken } = useGatewayToken();
  const [draft, setDraft] = useState(token);
  const [show, setShow] = useState(false);
  const status = useBridgeStatus(token);

  useEffect(() => {
    if (open) {
      setDraft(token);
      setShow(false);
    }
  }, [open, token]);

  const handleSave = () => {
    setToken(draft);
    toast({
      title: draft.trim() ? "TOKEN GUARDADO" : "TOKEN LIMPIADO",
      description: draft.trim()
        ? "El gateway usará este token en cada petición."
        : "El bridge volverá a modo STANDBY.",
    });
    onOpenChange(false);
  };

  const handleClear = () => {
    clearToken();
    setDraft("");
    toast({ title: "TOKEN ELIMINADO", description: "Se eliminó del almacenamiento local." });
  };

  const statusColor =
    status === "ONLINE"
      ? "text-green-neon"
      : status === "CHECKING"
        ? "text-cyan"
        : "text-muted-foreground";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-cyan/30 bg-surface">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-mono text-sm uppercase tracking-widest text-cyan">
            <KeyRound className="h-4 w-4" /> Gateway Settings
          </DialogTitle>
          <DialogDescription className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
            Configura el OpenClaw Gateway Token para esta tablet.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="flex items-center justify-between rounded-md border border-border bg-surface-2/60 px-3 py-2">
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Bridge status
            </span>
            <span className={cn("flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-widest", statusColor)}>
              <span
                className={cn(
                  "h-2 w-2 rounded-full",
                  status === "ONLINE" && "bg-green-neon pulse-dot",
                  status === "CHECKING" && "bg-cyan animate-pulse",
                  status === "STANDBY" && "bg-muted-foreground",
                )}
              />
              {status}
            </span>
          </div>

          <div className="space-y-2">
            <Label htmlFor="gateway-token" className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              OpenClaw Gateway Token
            </Label>
            <div className="relative">
              <Input
                id="gateway-token"
                type={show ? "text" : "password"}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="ocg_xxxxxxxxxxxxxxxxxxxx"
                autoComplete="off"
                spellCheck={false}
                className="pr-10 font-mono text-sm"
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-cyan"
                aria-label={show ? "Ocultar token" : "Mostrar token"}
              >
                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <p className="font-mono text-[10px] text-muted-foreground">
              Se guarda en LocalStorage de este navegador. No se envía a Supabase.
            </p>
          </div>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleClear}
            disabled={!hasToken && !draft}
            className="font-mono text-xs uppercase tracking-widest text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" /> Limpiar
          </Button>
          <Button
            type="button"
            onClick={handleSave}
            className="bg-cyan font-mono text-xs uppercase tracking-widest text-cyan-foreground hover:bg-cyan/90 glow-cyan"
          >
            <Save className="mr-1 h-3.5 w-3.5" /> Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
