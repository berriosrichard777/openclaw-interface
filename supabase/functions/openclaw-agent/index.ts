import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";

// NOTE: x-gateway-token is intentionally NOT allowed. The bridge token is
// read exclusively from the OPENCLAW_BRIDGE_TOKEN backend secret. The
// frontend MUST NOT send any token header.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
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
  | "diagnostic"
  | "telegram-status";

// Bridge endpoint map. All routes are GET.
const BRIDGE_ROUTES: Record<Exclude<BridgeAction, "diagnostic" | "telegram-status">, string> = {
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
  if (/telegram/.test(c)) return "telegram-status";
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

// ---- Telegram status helpers --------------------------------------------
// Safe deep-search: walks any JSON value looking for a key (case-insensitive)
// matching one of the candidates. Returns the first non-null/undefined match.
const SENSITIVE_KEY_RE = /(token|secret|authorization|api[_-]?key|password|bearer)/i;

const deepFind = (root: unknown, candidates: RegExp[]): unknown => {
  const seen = new Set<unknown>();
  const stack: unknown[] = [root];
  while (stack.length) {
    const node = stack.pop();
    if (node === null || node === undefined) continue;
    if (typeof node !== "object") continue;
    if (seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const v of node) stack.push(v);
      continue;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(k)) continue; // never read sensitive fields
      for (const re of candidates) {
        if (re.test(k) && v !== null && v !== undefined && v !== "") {
          return v;
        }
      }
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return undefined;
};

const fmt = (v: unknown): string => {
  if (v === undefined || v === null || v === "") return "unknown";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") {
    // Redact anything that looks sensitive even if it slipped through.
    if (SENSITIVE_KEY_RE.test(v)) return "[redacted]";
    return v.length > 200 ? v.slice(0, 200) + "…" : v;
  }
  if (typeof v === "number") return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 200 ? s.slice(0, 200) + "…" : s;
  } catch {
    return "unknown";
  }
};

const buildTelegramSummary = (
  health: BridgeCallResult,
  status: BridgeCallResult,
  logs: BridgeCallResult,
): string => {
  // Try to locate a "telegram" sub-object first; fall back to root scans.
  const sources: unknown[] = [];
  for (const c of [health, status]) {
    const tg = deepFind(c.body, [/^telegram$/i, /^tg$/i]);
    if (tg) sources.push(tg);
    sources.push(c.body); // also allow root-level keys
  }

  const find = (...keys: RegExp[]) => {
    for (const src of sources) {
      const v = deepFind(src, keys);
      if (v !== undefined) return v;
    }
    return undefined;
  };

  const configured = find(/^(telegram[_-]?)?configured$/i, /^enabled$/i, /^is[_-]?configured$/i);
  const username   = find(/^bot[_-]?username$/i, /^username$/i, /^bot$/i);
  const running    = find(/^running$/i, /^is[_-]?running$/i, /^alive$/i, /^active$/i);
  const lastProbe  = find(/^last[_-]?probe$/i, /^last[_-]?check$/i, /^probed[_-]?at$/i, /^last[_-]?seen$/i);
  const lastError  = find(/^last[_-]?error$/i, /^error$/i, /^last[_-]?err$/i);
  const webhookUrl = find(/^webhook[_-]?url$/i, /^webhook$/i);
  const canJoin    = find(/^can[_-]?join[_-]?groups$/i);
  const canReadAll = find(/^can[_-]?read[_-]?all[_-]?group[_-]?messages$/i);

  // ---- Logs scan: look for evidence that sendMessage succeeded ----------
  // We scan the logs body as text, regardless of whether it's JSON or raw.
  let logsText = "";
  try {
    logsText = typeof logs.body === "string"
      ? logs.body
      : JSON.stringify(logs.body);
  } catch {
    logsText = "";
  }

  // Detect "telegram sendMessage ok" (case-insensitive, tolerant of punctuation).
  const sendOkRe = /telegram[^\n]{0,40}send[_-]?message[^\n]{0,20}\bok\b/i;
  const sendMessageOk = sendOkRe.test(logsText);

  // Try to extract the latest timestamp from a log line that mentions telegram.
  // Supports ISO-8601 timestamps; falls back to bracketed times.
  let lastTelegramLogTs: string | undefined;
  const lineRe = /[^\n\r]*telegram[^\n\r]*/gi;
  const isoRe  = /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/;
  const tgLines = logsText.match(lineRe) ?? [];
  for (const ln of tgLines) {
    const m = ln.match(isoRe);
    if (m) lastTelegramLogTs = m[0]; // last match wins → most recent
  }

  // ---- Verdict ----------------------------------------------------------
  // OPERATIONAL    → configured + sendMessage ok in logs (even if running=false)
  // PARTIAL OK     → configured + sendMessage ok but a runtime field disagrees
  // WARNING / ERROR / OK as before for other cases.
  let verdict: "OK" | "OPERATIONAL" | "PARTIAL OK" | "WARNING" | "ERROR" = "OK";
  if (!health.ok || !status.ok) verdict = "WARNING";
  if (configured === false) verdict = "WARNING";
  if (running === false) verdict = "WARNING";
  if (lastError && typeof lastError === "string" && lastError.trim() !== "") verdict = "ERROR";

  // sendMessage success overrides "running=false" warning.
  if (configured === true && sendMessageOk) {
    verdict = running === false ? "PARTIAL OK" : "OPERATIONAL";
  }

  const headline = (verdict === "OPERATIONAL" || verdict === "PARTIAL OK")
    ? `TELEGRAM STATUS :: OPERATIONAL / ${verdict === "PARTIAL OK" ? "PARTIAL OK" : "OK"}`
    : `TELEGRAM STATUS :: ${verdict}`;

  const lines = [
    headline,
    "",
    `  configured                 : ${fmt(configured)}`,
    `  bot username               : ${fmt(username)}`,
    `  send message test detected : ${sendMessageOk ? "true" : "false"}`,
    `  running field              : ${fmt(running)}`,
    `  last probe                 : ${fmt(lastProbe)}`,
    `  last error                 : ${fmt(lastError)}`,
    `  last telegram log ts       : ${fmt(lastTelegramLogTs)}`,
    `  webhook url                : ${webhookUrl ? "present" : "unknown"}`,
    `  can join groups            : ${fmt(canJoin)}`,
    `  can read all messages      : ${fmt(canReadAll)}`,
    "",
    `  sources :: health HTTP ${health.status} · status HTTP ${status.status} · logs HTTP ${logs.status}`,
  ];

  // Contextual explanations.
  if (configured === true && sendMessageOk && running === false) {
    lines.push(
      "",
      "RUNTIME WARNING ::",
      "  OpenClaw reports running=false, but Telegram sendMessage succeeded",
      "  in recent logs. Telegram is operational for outbound messaging;",
      "  the running flag may reflect a stale or partial runtime probe.",
    );
  } else if (configured === true && running === false && !sendMessageOk) {
    lines.push(
      "",
      "EXPLANATION ::",
      "  Telegram está configurado, pero OpenClaw lo reporta como no running",
      "  y no se detectaron envíos exitosos en los logs recientes.",
    );
  } else if (lastError && typeof lastError === "string" && lastError.trim() !== "") {
    lines.push(
      "",
      "EXPLANATION ::",
      "  Telegram reporta un error reciente. Revisa los logs y el estado",
      "  del gateway/channel para más contexto.",
    );
  } else if (configured === false) {
    lines.push(
      "",
      "EXPLANATION ::",
      "  Telegram no está configurado en OpenClaw. Esta acción es read-only,",
      "  no inicializa ni modifica la integración.",
    );
  }

  // Recommended checks: shown unless verdict is plain OK / OPERATIONAL.
  if (verdict !== "OK" && verdict !== "OPERATIONAL") {
    lines.push(
      "",
      "RECOMMENDED CHECKS ::",
      "  • Review Telegram runtime/plugin status",
      "  • Monitor future Telegram logs",
      "  • Send another test message if needed",
      "",
      "  (read-only :: no restart, webhook change, or configuration change performed)",
    );
  }

  return lines.join("\n");
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

    // SECURITY: token is read ONLY from backend secrets. No header fallback,
    // no client-supplied token, no LocalStorage path. Never logged or echoed.
    const bridgeToken = Deno.env.get("OPENCLAW_BRIDGE_TOKEN");

    // Base URL: prefer OPENCLAW_BRIDGE_URL secret, fall back to legacy default.
    const VPS_BASE = (Deno.env.get("OPENCLAW_BRIDGE_URL") ?? "https://ai.richops.cloud")
      .replace(/\/+$/, "");

    if (!bridgeToken) {
      return new Response(
        JSON.stringify({
          error: "Bridge token not configured",
          reply:
            "BRIDGE TOKEN NOT CONFIGURED :: ask an administrator to set " +
            "OPENCLAW_BRIDGE_TOKEN in backend secrets.",
          calls: [],
        }),
        {
          status: 503,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Resolve which action to perform.
    const action: BridgeAction | null =
      body.action ?? interpretCommand(body.command);

    let reply: string;
    let calls: BridgeCallResult[] = [];

    if (!action) {
      reply = [
        "UNRECOGNIZED COMMAND :: no matching bridge endpoint.",
        "Available actions: health, system, gateway-status, status, logs, diagnostic, telegram-status.",
        `> ${body.command.trim()}`,
      ].join("\n");
    } else if (action === "diagnostic") {
      // Full Diagnostic: run health + system + gateway-status + status in parallel.
      const order: Array<Exclude<BridgeAction, "diagnostic" | "telegram-status">> = [
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
    } else if (action === "telegram-status") {
      // Telegram status :: composes data from health + status + logs(100).
      // No new bridge endpoint needed; never exposes tokens or headers.
      const [h, s, l] = await Promise.all([
        callBridge(VPS_BASE, "/api/openclaw/health", bridgeToken),
        callBridge(VPS_BASE, "/api/openclaw/status", bridgeToken),
        callBridge(VPS_BASE, "/api/openclaw/logs?lines=100", bridgeToken),
      ]);
      calls = [h, s, l];
      reply = buildTelegramSummary(h, s, l);
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
    // Generic error — never include secret material.
    console.error("openclaw-agent error");
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
