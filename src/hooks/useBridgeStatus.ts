import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export type BridgeStatus = "ONLINE" | "STANDBY" | "CHECKING";

const POLL_INTERVAL = 30_000; // 30s

/**
 * Bridge status probe.
 *
 * SECURITY: This hook does NOT touch any token. It calls the
 * `openclaw-agent` Edge Function with `action: "health"`. The bridge token
 * lives exclusively in backend secrets (OPENCLAW_BRIDGE_TOKEN).
 */
export function useBridgeStatus() {
  const [status, setStatus] = useState<BridgeStatus>("CHECKING");

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const ping = async () => {
      try {
        const { data, error } = await supabase.functions.invoke("openclaw-agent", {
          body: { command: "bridge health probe", action: "health" },
        });
        if (cancelled) return;
        if (error) {
          setStatus("STANDBY");
          return;
        }
        const ok = Array.isArray(data?.calls) && data.calls[0]?.ok === true;
        setStatus(ok ? "ONLINE" : "STANDBY");
      } catch {
        if (!cancelled) setStatus("STANDBY");
      }
    };

    setStatus("CHECKING");
    ping();
    timer = window.setInterval(ping, POLL_INTERVAL);
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, []);

  return status;
}
