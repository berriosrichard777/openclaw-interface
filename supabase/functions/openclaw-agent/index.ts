import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-gateway-token, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface AgentRequest {
  command: string;
  model?: string;
  skills?: string[];
  // Optional: explicit action from UI buttons (bypasses NL interpretation).
  action?: BridgeAction;
}

type BridgeAction =
  | "health"
  | "system"
  | "gateway-status"
  | "status"
  | "logs"
  | "diagnostic";

// Bridge endpoint map. All routes are GET.
const BRIDGE_ROUTES: Record<Exclude<BridgeAction, "diagnostic">, string> = {
  "health": "/api/openclaw/health",
  "system": "/api/openclaw/system",
  "gateway-status": "/api/openclaw/gateway-status",
  "status": "/api/openclaw/status",
  "logs": "/api/openclaw/logs?lines=50",
};

// Interpret a free-text command into a known bridge action.
const interpretCommand = (cmd: string): BridgeAction | null => {
  const c = cmd.trim().toLowerCase();
  if (!c) return null;
  if (/(full[\s_-]*)?diagnostic|sweep|full[\s_-]*scan/.test(c)) return "diagnostic";
  if (/\blogs?\b|tail|journal|events/.test(c)) return "logs";
  if (/gateway/.test(c)) return "gateway-status";
  if (/\bhealth\b|ping|alive/.test(c)) return "health";
  if (/\bsystem\b|uname|host|cpu|mem(ory)?|disk/.test(c)) return "system";
  if (/\bstatus\b|state|report/.test(c)) return "status";
  return null;
};

interface BridgeCallResult {
  endpoint: string;
  status: number;
  ok: boolean;
  body: unknown;
}

const callBridge = async (
  base: string,
  path: string,
  token: string,
): Promise<BridgeCallResult> => {
  const url = `${base}${path}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
      },
    });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep raw text */ }
    return { endpoint: path, status: res.status, ok: res.ok, body: parsed };
  } catch (e) {
    return {
      endpoint: path,
      status: 0,
      ok: false,
      body: { error: (e as Error).message },
    };
  }
};

const formatResult = (label: string, r: BridgeCallResult): string => {
  const head = `▸ ${label}  [${r.endpoint}]  ::  HTTP ${r.status}${r.ok ? "" : "  ✖"}`;
  const json = typeof r.body === "string"
    ? r.body
    : JSON.stringify(r.body, null, 2);
  return `${head}\n${json}`;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = userData.user.id;

    const body = (await req.json()) as AgentRequest;
    if (!body?.command || typeof body.command !== "string") {
      return new Response(JSON.stringify({ error: "command required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Token resolution priority:
    //   1. Per-request token forwarded from client (Settings modal / LocalStorage)
    //   2. OPENCLAW_BRIDGE_TOKEN (preferred server-side secret)
    //   3. OPENCLAW_API_KEY (legacy fallback)
    const headerToken = req.headers.get("x-gateway-token")?.trim();
    const bridgeToken =
      headerToken ||
      Deno.env.get("OPENCLAW_BRIDGE_TOKEN") ||
      Deno.env.get("OPENCLAW_API_KEY");

    // Base URL: prefer OPENCLAW_BRIDGE_URL secret, fall back to legacy default.
    const VPS_BASE = (Deno.env.get("OPENCLAW_BRIDGE_URL") ?? "https://ai.richops.cloud")
      .replace(/\/+$/, "");

    // Resolve which action to perform.
    const action: BridgeAction | null =
      body.action ?? interpretCommand(body.command);

    let reply: string;
    let calls: BridgeCallResult[] = [];

    if (!bridgeToken) {
      reply =
        "BRIDGE TOKEN MISSING :: configure OPENCLAW_BRIDGE_TOKEN in backend secrets " +
        "or paste a Gateway Token via the Settings dialog.";
    } else if (!action) {
      reply = [
        "UNRECOGNIZED COMMAND :: no matching bridge endpoint.",
        "Available actions: health, system, gateway-status, status, logs, diagnostic.",
        `> ${body.command.trim()}`,
      ].join("\n");
    } else if (action === "diagnostic") {
      // Full Diagnostic: run health + system + gateway-status + status in parallel.
      const order: Array<Exclude<BridgeAction, "diagnostic">> = [
        "health", "system", "gateway-status", "status",
      ];
      calls = await Promise.all(
        order.map((a) => callBridge(VPS_BASE, BRIDGE_ROUTES[a], bridgeToken)),
      );
      const allOk = calls.every((c) => c.ok);
      reply = [
        `FULL DIAGNOSTIC :: ${allOk ? "ALL SYSTEMS GREEN" : "ISSUES DETECTED"}`,
        "",
        ...calls.map((c, i) => formatResult(order[i].toUpperCase(), c)),
      ].join("\n\n");
    } else {
      const path = BRIDGE_ROUTES[action];
      const r = await callBridge(VPS_BASE, path, bridgeToken);
      calls = [r];
      reply = formatResult(action.toUpperCase(), r);
    }

    // Log a TERMINAL event for traceability (never includes the token).
    await supabase.from("activity_logs").insert({
      user_id: userId,
      source: "TERMINAL",
      level: calls.length && calls.every((c) => c.ok) ? "OK" : "INFO",
      message:
        `${action ?? "unknown"} :: ${body.command.slice(0, 100)}` +
        (calls.length ? ` :: ${calls.map((c) => c.status).join("/")}` : ""),
    });

    return new Response(
      JSON.stringify({
        reply,
        action,
        model: body.model,
        agent: "OPENCLAW_AGENT_V2.5",
        calls: calls.map((c) => ({
          endpoint: c.endpoint,
          status: c.status,
          ok: c.ok,
          body: c.body,
        })),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
    );
  } catch (e) {
    console.error("openclaw-agent error", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
