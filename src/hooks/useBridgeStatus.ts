import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export type BridgeStatus = "ONLINE" | "STANDBY" | "CHECKING" | "IDLE";

/**
 * Bridge status (manual only).
 *
 * SECURITY: Does NOT touch any token. Calls the `openclaw-agent` Edge
 * Function with `action: "health"`. The bridge token lives exclusively in
 * backend secrets (OPENCLAW_BRIDGE_TOKEN).
 *
 * NOTE: Auto-refresh is intentionally disabled. The status only updates
 * when `check()` is invoked manually (e.g. by a button). A toggleable
 * auto-refresh will be added in a later iteration.
 */
export function useBridgeStatus() {
  const [status, setStatus] = useState<BridgeStatus>("IDLE");

  const check = async () => {
    setStatus("CHECKING");
    try {
      const { data, error } = await supabase.functions.invoke("openclaw-agent", {
        body: { command: "bridge health probe", action: "health" },
      });
      if (error) {
        setStatus("STANDBY");
        return;
      }
      const ok = Array.isArray(data?.calls) && data.calls[0]?.ok === true;
      setStatus(ok ? "ONLINE" : "STANDBY");
    } catch {
      setStatus("STANDBY");
    }
  };

  return { status, check };
}
