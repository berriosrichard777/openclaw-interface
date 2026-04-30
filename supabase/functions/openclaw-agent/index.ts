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
  | "telegram-status"
  | "stability"
  | "alerts";

// ---- Forbidden / unsafe intents -----------------------------------------
// Any command that matches these patterns is rejected locally and never
// forwarded to the bridge. Read-only diagnostics only.
const FORBIDDEN_PATTERNS: RegExp[] = [
  /\bdelete\b/i, /\bremove\b/i, /\brm\s+-/i, /\bdrop\b/i, /\bpurge\b/i,
  /\bstop\s+(server|service|bot|gateway|telegram|docker|bridge)\b/i,
  /\brestart\b/i, /\breboot\b/i, /\bshutdown\b/i, /\bkill\b/i,
  /\bchange\s+(token|secret|password|config)\b/i,
  /\bedit\s+(config|env|secret|token)\b/i,
  /\bset\s+(token|secret|password|env)\b/i,
  /\b(rotate|revoke)\s+(token|key|secret)\b/i,
  /\bdocker\b/i, /\bkubectl\b/i, /\bsystemctl\b/i, /\bsudo\b/i,
  /\bshell\b/i, /\bbash\b/i, /\bsh\s+-c\b/i, /\bexec\b/i, /\bspawn\b/i,
  /\bcloudflare\b/i, /\bdns\b/i, /\bfirewall\b/i, /\biptables\b/i,
  /\bcat\s+\/?(etc|root|home|var)\b/i, /\bchmod\b/i, /\bchown\b/i,
  /\b(show|expose|reveal|print|leak|dump)\s+(the\s+)?(token|secret|password|api[_-]?key|env|credential)/i,
  /\bwhat('?s| is)\s+(the\s+)?(token|secret|password|api[_-]?key)\b/i,
  /\bgive me (the )?(token|secret|password|api[_-]?key)\b/i,
  /\binstall\b/i, /\bupdate\s+(package|apt|npm)\b/i, /\bnpm\s+(install|i|run)\b/i,
];

const isForbidden = (cmd: string): boolean =>
  FORBIDDEN_PATTERNS.some((re) => re.test(cmd));

// Bridge endpoint map. All routes are GET.
const BRIDGE_ROUTES: Record<Exclude<BridgeAction, "diagnostic" | "telegram-status">, string> = {
  "health": "/api/openclaw/health",
  "system": "/api/openclaw/system",
  "gateway-status": "/api/openclaw/gateway-status",
  "status": "/api/openclaw/status",
  "logs": "/api/openclaw/logs?lines=50",
};

// Interpret a free-text command into a known bridge action.
// Supports English + Spanish natural phrases. Returns null if no safe match.
const interpretCommand = (cmd: string): BridgeAction | null => {
  const c = cmd.trim().toLowerCase();
  if (!c) return null;

  // Telegram
  if (/telegram|por\s*qu[eé]\s+telegram|revisa\s+telegram/.test(c)) return "telegram-status";

  // Alert Center
  if (/\balerts?\b|alert\s*center|qu[eé]\s+problemas|warnings?\s+activos|active\s+warnings/.test(c))
    return "alerts";

  // Stability / overall health
  if (/stability|estado\s+general|todo\s+est[aá]\s+bien|all\s+(ok|good|fine)|system\s+stability/.test(c))
    return "stability";

  // Diagnostic
  if (/(full[\s_-]*)?diagnostic|sweep|full[\s_-]*scan|diagn[oó]stico|haz\s+un\s+diagn/.test(c))
    return "diagnostic";

  // Logs / errors / warnings
  if (/\blogs?\b|tail|journal|events|errores?\s+recientes|warnings?\s+recientes|mu[eé]strame\s+logs/.test(c))
    return "logs";

  // Gateway
  if (/gateway/.test(c)) return "gateway-status";

  // Health / alive / online
  if (/\bhealth\b|ping|alive|est[aá]\s+vivo|bridge\s+online|check\s+bridge|revisa\s+health/.test(c))
    return "health";

  // System resources
  if (/\bsystem\b|uname|host|cpu|ram|mem(ory)?|disk|recursos|estado\s+del\s+sistema/.test(c))
    return "system";

  // General status
  if (/\bstatus\b|state|report|estado/.test(c)) return "status";

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

// ---- Natural-language summaries -----------------------------------------
// Wraps a single bridge call into a friendly status / explanation / next-step
// summary. Raw technical data is appended only when wantsRaw is true.
const naturalize = (
  action: BridgeAction,
  r: BridgeCallResult,
  wantsRaw: boolean,
): string => {
  const labelMap: Record<string, string> = {
    "health": "Bridge Health",
    "system": "System Resources",
    "gateway-status": "Gateway Link",
    "status": "Agent Status",
    "logs": "Recent Logs",
  };
  const label = labelMap[action] ?? action.toUpperCase();
  const ok = r.ok;
  const status = ok ? "OK" : r.status === 0 ? "UNREACHABLE" : "DEGRADED";

  const lines: string[] = [
    `${label.toUpperCase()} :: ${status}`,
    "",
  ];

  if (action === "health") {
    lines.push(ok
      ? "  Bridge responded successfully — OpenClaw is alive and reachable."
      : "  Bridge did not respond cleanly. The agent may be offline or the link is degraded.");
    if (!ok) lines.push("  Next step: check Gateway Link and try again in a few seconds.");
  } else if (action === "system") {
    const cpu = findNum(r.body, /^cpu([_-]?(pct|percent|usage|load))?$/i);
    const ram = findRamPercent(r.body);
    const disk = findNum(r.body, /^(disk|storage)([_-]?(pct|percent|usage))?$/i);
    lines.push(`  CPU: ${fmtPct(cpu)} · RAM: ${fmtPct(ram)} · Disk: ${fmtPct(disk)}`);
    const hot = [cpu, ram, disk].some((v) => typeof v === "number" && v >= 90);
    const warm = [cpu, ram, disk].some((v) => typeof v === "number" && v >= 75);
    lines.push(hot
      ? "  System resources are critical — investigate immediately."
      : warm
      ? "  System resources are elevated — keep an eye on usage."
      : "  System resources look normal.");
    if (hot || warm) lines.push("  Next step: open System Stability Monitor for the full picture.");
  } else if (action === "gateway-status") {
    lines.push(ok
      ? "  Gateway link reports OK."
      : "  Gateway link is degraded or unreachable.");
    if (!ok) lines.push("  Next step: re-run diagnostic to confirm whether bridge or gateway is at fault.");
  } else if (action === "status") {
    lines.push(ok ? "  General agent status responded successfully." : "  Agent did not return a clean status.");
  } else if (action === "logs") {
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? "");
    const errCount = (text.match(/\b(ERROR|FATAL|exception|failed)\b/gi) ?? []).length;
    const warnCount = (text.match(/\bWARN(ING)?\b/gi) ?? []).length;
    lines.push(`  Errors: ${errCount} · Warnings: ${warnCount}`);
    lines.push(errCount === 0 && warnCount === 0
      ? "  No notable issues found in recent logs."
      : "  Recent log activity contains warnings or errors — review System Logs for context.");
  }

  if (wantsRaw) {
    lines.push("", "RAW ::", typeof r.body === "string" ? r.body : JSON.stringify(r.body, null, 2));
  } else {
    lines.push("", "  (type 'details' or 'raw' to see the technical payload)");
  }
  return lines.join("\n");
};

const fmtPct = (v: number | null): string =>
  v === null || !isFinite(v) ? "unknown" : `${Math.round(v)}%`;

const findNum = (root: unknown, keyRe: RegExp): number | null => {
  let out: number | null = null;
  const stack: unknown[] = [root];
  const seen = new Set<unknown>();
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== "object" || seen.has(n)) continue;
    seen.add(n);
    for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(k)) continue;
      if (out === null && keyRe.test(k)) {
        if (typeof v === "number" && isFinite(v)) {
          out = v > 1 && v <= 100 ? v : v <= 1 ? Math.round(v * 1000) / 10 : v;
        } else if (typeof v === "string") {
          const m = v.match(/(\d+(?:\.\d+)?)/);
          if (m) out = parseFloat(m[1]);
        }
      }
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return out;
};

const findRamPercent = (root: unknown): number | null => {
  // Direct percent first.
  const direct = findNum(root, /^(ram|mem(ory)?)([_-]?(pct|percent|usage))?$/i);
  if (direct !== null && direct <= 100) return direct;
  // Compute from used / total.
  const used = findNum(root, /^(mem(ory)?|ram)[_-]?(used|in[_-]?use)$/i);
  const total = findNum(root, /^(mem(ory)?|ram)[_-]?(total|max|size)$/i);
  if (used !== null && total !== null && total > 0) {
    const p = (used / total) * 100;
    if (p >= 0 && p <= 100) return p;
  }
  return null;
};

// Stability summary (composes health + system + gateway + telegram).
const buildStabilitySummary = (
  health: BridgeCallResult,
  system: BridgeCallResult,
  gateway: BridgeCallResult,
  telegram: BridgeCallResult,
  logs: BridgeCallResult,
): string => {
  const cpu = findNum(system.body, /^cpu([_-]?(pct|percent|usage|load))?$/i);
  const ram = findRamPercent(system.body);
  const disk = findNum(system.body, /^(disk|storage)([_-]?(pct|percent|usage))?$/i);

  const bridgeOk = health.ok;
  const gatewayOk = gateway.ok;
  const sysOk = system.ok;
  const tgOk = telegram.ok;

  const hot = [cpu, ram, disk].some((v) => typeof v === "number" && v >= 90);
  const warm = [cpu, ram, disk].some((v) => typeof v === "number" && v >= 75);

  let verdict: "HEALTHY" | "WARNING" | "CRITICAL" = "HEALTHY";
  if (!bridgeOk || !gatewayOk || !sysOk || hot) verdict = "CRITICAL";
  else if (!tgOk || warm || ram === null) verdict = "WARNING";

  return [
    `SYSTEM STABILITY :: ${verdict}`,
    "",
    `  Bridge   : ${bridgeOk ? "OK" : "DOWN"}`,
    `  Gateway  : ${gatewayOk ? "OK" : "DEGRADED"}`,
    `  System   : CPU ${fmtPct(cpu)} · RAM ${fmtPct(ram)} · Disk ${fmtPct(disk)}`,
    `  Telegram : ${tgOk ? "reachable" : "unreachable"}`,
    "",
    verdict === "HEALTHY"
      ? "  All core systems look stable."
      : verdict === "WARNING"
      ? "  Some non-critical signals need attention. Open the System Stability Monitor for details."
      : "  Critical signal detected. Open the System Stability Monitor and Alert Center now.",
  ].join("\n");
};

// Alerts summary (lightweight overview based on the same probes).
const buildAlertsSummary = (
  health: BridgeCallResult,
  system: BridgeCallResult,
  gateway: BridgeCallResult,
  telegram: BridgeCallResult,
  logs: BridgeCallResult,
): string => {
  const alerts: { sev: "CRIT" | "WARN" | "INFO"; msg: string }[] = [];
  if (!health.ok) alerts.push({ sev: "CRIT", msg: "Bridge health probe failed." });
  if (!gateway.ok) alerts.push({ sev: "CRIT", msg: "Gateway link probe failed." });
  if (!system.ok) alerts.push({ sev: "CRIT", msg: "System snapshot probe failed." });

  const ram = findRamPercent(system.body);
  if (ram === null) alerts.push({ sev: "INFO", msg: "RAM usage unknown — CPU and Disk evaluated independently." });
  else if (ram > 90) alerts.push({ sev: "CRIT", msg: `RAM critical (${Math.round(ram)}%).` });
  else if (ram >= 75) alerts.push({ sev: "WARN", msg: `RAM elevated (${Math.round(ram)}%).` });

  const text = typeof logs.body === "string" ? logs.body : JSON.stringify(logs.body ?? "");
  if (/\bWARN(ING)?\b/i.test(text)) alerts.push({ sev: "WARN", msg: "Recent warnings found in logs." });

  const counts = { CRIT: 0, WARN: 0, INFO: 0 };
  for (const a of alerts) counts[a.sev]++;

  const head = `ALERT CENTER :: ${counts.CRIT} Crit · ${counts.WARN} Warn · ${counts.INFO} Info`;
  if (alerts.length === 0) {
    return `${head}\n\n  No active alerts. System looks stable.`;
  }
  return [
    head,
    "",
    ...alerts.map((a) => `  [${a.sev}] ${a.msg}`),
    "",
    "  Open the Alert Center on the Dashboard for the full breakdown.",
  ].join("\n");
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

    // Caller asked for verbose/raw output ("details", "raw", "verbose", "json").
    const wantsRaw = !body.action && /\b(details?|raw|verbose|json|technical)\b/i.test(body.command);

    // SECURITY GUARD :: forbidden intents are rejected locally and never
    // forwarded to the VPS bridge. Only safe read-only diagnostics are allowed.
    if (!body.action && isForbidden(body.command)) {
      const refusal =
        "REQUEST BLOCKED ::\n" +
        "  This action is not allowed from Command Chat. Only safe read-only " +
        "diagnostics are enabled.\n\n" +
        "  Allowed intents :: health · system · gateway · logs · diagnostic · " +
        "telegram · stability · alerts.";
      await supabase.from("activity_logs").insert({
        user_id: userId,
        source: "TERMINAL",
        level: "WARN",
        message: `blocked :: ${body.command.slice(0, 120)}`,
      });
      return new Response(
        JSON.stringify({
          reply: refusal,
          action: null,
          blocked: true,
          agent: "OPENCLAW_AGENT_V2.5",
          calls: [],
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
      );
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
        "UNRECOGNIZED COMMAND ::",
        "  I couldn't map that to a safe diagnostic intent.",
        "",
        "  Try: 'check health', 'system status', 'gateway', 'logs',",
        "  'full diagnostic', 'telegram status', 'stability', 'alerts'.",
        "",
        "  (Free-form commands to the VPS, shell, Docker, Cloudflare or",
        "  filesystem are intentionally disabled. Read-only diagnostics only.)",
      ].join("\n");
    } else if (action === "diagnostic") {
      const order: Array<Exclude<BridgeAction, "diagnostic" | "telegram-status" | "stability" | "alerts">> = [
        "health", "system", "gateway-status", "status",
      ];
      calls = await Promise.all(
        order.map((a) => callBridge(VPS_BASE, BRIDGE_ROUTES[a], bridgeToken)),
      );
      const allOk = calls.every((c) => c.ok);
      const head = `FULL DIAGNOSTIC :: ${allOk ? "ALL SYSTEMS GREEN" : "ISSUES DETECTED"}`;
      const summary = allOk
        ? "  Bridge, system, gateway and status all responded cleanly."
        : "  One or more probes failed — review the per-endpoint detail below.";
      const nextStep = allOk
        ? ""
        : "\n  Next step: run 'stability' for the consolidated verdict, or 'alerts' for actionable items.";
      const tail = wantsRaw
        ? "\n\nRAW ::\n" + calls.map((c, i) => formatResult(order[i].toUpperCase(), c)).join("\n\n")
        : "\n\n  (type 'details' or 'raw' to see the technical payload)";
      reply = `${head}\n\n${summary}${nextStep}${tail}`;
    } else if (action === "telegram-status") {
      const [h, s, l] = await Promise.all([
        callBridge(VPS_BASE, "/api/openclaw/health", bridgeToken),
        callBridge(VPS_BASE, "/api/openclaw/status", bridgeToken),
        callBridge(VPS_BASE, "/api/openclaw/logs?lines=100", bridgeToken),
      ]);
      calls = [h, s, l];
      reply = buildTelegramSummary(h, s, l);
      if (wantsRaw) {
        reply += "\n\nRAW ::\n" + calls.map((c) => formatResult(c.endpoint, c)).join("\n\n");
      }
    } else if (action === "stability" || action === "alerts") {
      const [h, sys, gw, tg, lg] = await Promise.all([
        callBridge(VPS_BASE, "/api/openclaw/health", bridgeToken),
        callBridge(VPS_BASE, "/api/openclaw/system", bridgeToken),
        callBridge(VPS_BASE, "/api/openclaw/gateway-status", bridgeToken),
        callBridge(VPS_BASE, "/api/openclaw/status", bridgeToken),
        callBridge(VPS_BASE, "/api/openclaw/logs?lines=100", bridgeToken),
      ]);
      calls = [h, sys, gw, tg, lg];
      reply = action === "stability"
        ? buildStabilitySummary(h, sys, gw, tg, lg)
        : buildAlertsSummary(h, sys, gw, tg, lg);
      if (wantsRaw) {
        reply += "\n\nRAW ::\n" + calls.map((c) => formatResult(c.endpoint, c)).join("\n\n");
      }
    } else {
      const path = BRIDGE_ROUTES[action];
      const r = await callBridge(VPS_BASE, path, bridgeToken);
      calls = [r];
      // When the UI passes an explicit action (button click), keep the raw
      // formatted output to preserve existing diagnostic panels.
      reply = body.action
        ? formatResult(action.toUpperCase(), r)
        : naturalize(action, r, wantsRaw);
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
