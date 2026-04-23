import { useEffect, useState } from "react";
import { getGatewayToken } from "./useGatewayToken";

export type BridgeStatus = "ONLINE" | "STANDBY" | "CHECKING";

const VPS_BASE = "https://ai.richops.cloud";
const POLL_INTERVAL = 30_000; // 30s

export function useBridgeStatus(token?: string) {
  const [status, setStatus] = useState<BridgeStatus>("CHECKING");
  const activeToken = token ?? getGatewayToken();

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const ping = async () => {
      if (!activeToken) {
        if (!cancelled) setStatus("STANDBY");
        return;
      }
      try {
        const ctrl = new AbortController();
        const t = window.setTimeout(() => ctrl.abort(), 5000);
        const res = await fetch(`${VPS_BASE}/health`, {
          method: "GET",
          headers: { Authorization: `Bearer ${activeToken}` },
          signal: ctrl.signal,
        });
        window.clearTimeout(t);
        if (!cancelled) setStatus(res.ok ? "ONLINE" : "STANDBY");
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
  }, [activeToken]);

  return status;
}
