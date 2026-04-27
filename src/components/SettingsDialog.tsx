import { ShieldCheck, ServerCog, RefreshCw } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useBridgeStatus } from "@/hooks/useBridgeStatus";
import { cn } from "@/lib/utils";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Settings panel.
 *
 * SECURITY: There is no token input field. The bridge token is stored ONLY
 * as a backend secret (OPENCLAW_BRIDGE_TOKEN) and is never read or held by
 * the browser. This dialog is read-only status information.
 *
 * Bridge status is manual: the user clicks "Check now" to probe.
 */
export const SettingsDialog = ({ open, onOpenChange }: SettingsDialogProps) => {
  const { status, check } = useBridgeStatus();
  const isChecking = status === "CHECKING";

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
            <ServerCog className="h-4 w-4" /> Bridge Settings
          </DialogTitle>
          <DialogDescription className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
            El bridge token se gestiona en backend. No se expone al navegador.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="flex items-center justify-between rounded-md border border-border bg-surface-2/60 px-3 py-2">
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Bridge status
            </span>
            <span
              className={cn(
                "flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-widest",
                statusColor,
              )}
            >
              <span
                className={cn(
                  "h-2 w-2 rounded-full",
                  status === "ONLINE" && "bg-green-neon pulse-dot",
                  status === "CHECKING" && "bg-cyan animate-pulse",
                  (status === "STANDBY" || status === "IDLE") && "bg-muted-foreground",
                )}
              />
              {status}
            </span>
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={check}
            disabled={isChecking}
            className="w-full justify-center gap-2 font-mono text-[11px] uppercase tracking-widest"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isChecking && "animate-spin")} />
            {isChecking ? "Checking..." : "Check now"}
          </Button>

          <p className="font-mono text-[10px] text-muted-foreground">
            Auto-refresh disabled. The bridge status only updates when you click
            "Check now" or run a probe from the dashboard.
          </p>

          <div className="rounded-md border border-border bg-surface-2/60 p-3">
            <div className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-green-neon" />
              <div className="space-y-1">
                <p className="font-mono text-[11px] uppercase tracking-widest text-foreground">
                  Token storage :: Backend only
                </p>
                <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
                  Todas las llamadas al bridge se realizan desde la Edge
                  Function usando <span className="text-cyan">OPENCLAW_BRIDGE_TOKEN</span>.
                  El navegador nunca recibe, almacena ni transmite el token.
                </p>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
