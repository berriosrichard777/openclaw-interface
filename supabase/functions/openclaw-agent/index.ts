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

// Tolerant probe-success check. A probe counts as OK when ANY of these hold:
//   - HTTP 2xx (res.ok)
//   - response.ok === true
//   - response.data.ok === true
//   - response.body.ok === true
//   - raw text contains "ok":true
// We intentionally IGNORE these as failure signals:
//   running=false, error=null, lastError=null, status="unknown",
//   tokenSource="none", internal warnings, or "Telegram Partial OK".
const isProbeOk = (r: BridgeCallResult): boolean => {
  if (r.status >= 200 && r.status < 300) return true;
  const b = r.body as any;
  if (b && typeof b === "object") {
    if (b.ok === true) return true;
    if (b.data && typeof b.data === "object" && b.data.ok === true) return true;
    if (b.body && typeof b.body === "object" && b.body.ok === true) return true;
  }
  const text = typeof r.body === "string" ? r.body : (() => {
    try { return JSON.stringify(r.body ?? ""); } catch { return ""; }
  })();
  if (/"ok"\s*:\s*true/i.test(text)) return true;
  return false;
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

// ---- Conversational response formatter ---------------------------------
// Standard format used across all natural-language replies:
//   Status:   OK / Warning / Critical / Blocked
//   Summary:  short natural-language explanation
//   Next step: concrete recommendation (optional)
//   Details:  raw payload, only when wantsRaw is true
type ConvoStatus = "OK" | "Warning" | "Critical" | "Blocked";

const conversational = (opts: {
  status: ConvoStatus;
  summary: string;
  nextStep?: string;
  raw?: BridgeCallResult[];
  wantsRaw?: boolean;
}): string => {
  const lines: string[] = [
    `Status: ${opts.status}`,
    `Summary: ${opts.summary}`,
  ];
  if (opts.nextStep && opts.nextStep.trim()) {
    lines.push(`Next step: ${opts.nextStep}`);
  }
  if (opts.wantsRaw && opts.raw && opts.raw.length) {
    lines.push("", "Details:", ...opts.raw.map((c) => formatResult(c.endpoint, c)));
  } else {
    lines.push("", "(type 'details' or 'raw' to see the technical payload)");
  }
  return lines.join("\n");
};

const buildTelegramSummary = (
  health: BridgeCallResult,
  status: BridgeCallResult,
  logs: BridgeCallResult,
): { status: ConvoStatus; summary: string; nextStep: string } => {
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
  let convoStatus: ConvoStatus = "OK";
  let summary = "Telegram está operativo.";
  let nextStep = "";

  const realError = lastError && typeof lastError === "string" && lastError.trim() !== "";

  if (configured === false) {
    convoStatus = "Critical";
    summary = "Telegram no está configurado en OpenClaw.";
    nextStep = "Revisa la configuración del bot en el backend (read-only desde aquí).";
  } else if (realError) {
    convoStatus = "Critical";
    summary = `Telegram reporta un error reciente (${fmt(lastError)}).`;
    nextStep = "Revisa System Logs → Errors y el estado del gateway/channel.";
  } else if (sendMessageOk) {
    // Envíos confirmados en logs → al menos parcialmente operativo.
    if (running === false) {
      convoStatus = "Warning";
      summary = "Telegram está parcialmente operativo. Puede enviar mensajes, pero OpenClaw reporta running=false.";
      nextStep = "Monitorea Telegram logs o revisa el plugin runtime si deja de responder.";
    } else {
      convoStatus = "OK";
      summary = `Telegram está operativo${username ? ` (bot ${fmt(username)})` : ""}. Envíos recientes confirmados en logs.`;
    }
  } else if (running === false) {
    convoStatus = "Warning";
    summary = "Telegram está configurado, pero no encontré envíos confirmados en los logs recientes.";
    nextStep = "Monitorea Telegram logs o revisa el plugin runtime.";
  } else if (configured === true) {
    convoStatus = "Warning";
    summary = "Telegram está configurado, pero no encontré envíos confirmados en los logs recientes.";
    nextStep = "Envía un mensaje de prueba o revisa Telegram logs.";
  } else if (!health.ok || !status.ok) {
    convoStatus = "Warning";
    summary = "No se pudo confirmar el estado de Telegram porque health/status no respondieron limpio.";
    nextStep = "Re-ejecuta 'health' y 'gateway' para descartar problemas de bridge.";
  } else {
    convoStatus = "OK";
    summary = `Telegram parece operativo${username ? ` (bot ${fmt(username)})` : ""}.`;
  }

  return { status: convoStatus, summary, nextStep };
};

// ---- Natural-language summaries -----------------------------------------
// Wraps a single bridge call into a friendly status / explanation / next-step
// summary. Raw technical data is appended only when wantsRaw is true.
const naturalize = (
  action: BridgeAction,
  r: BridgeCallResult,
): { status: ConvoStatus; summary: string; nextStep: string } => {
  const ok = r.ok;

  if (action === "health") {
    return ok
      ? { status: "OK", summary: "El bridge respondió correctamente. OpenClaw está vivo y accesible.", nextStep: "" }
      : { status: "Critical", summary: "El bridge no respondió limpio. El agente puede estar offline.", nextStep: "Revisa Gateway Link y reintenta en unos segundos." };
  }
  if (action === "system") {
    const cpu = findNum(r.body, /^cpu([_-]?(pct|percent|usage|load))?$/i);
    const ram = findRamPercent(r.body);
    const disk = findNum(r.body, /^(disk|storage)([_-]?(pct|percent|usage))?$/i);
    const hot = [cpu, ram, disk].some((v) => typeof v === "number" && v >= 90);
    const warm = [cpu, ram, disk].some((v) => typeof v === "number" && v >= 75);
    const ramTxt = ram === null ? "RAM unknown" : `RAM ${fmtPct(ram)}`;
    const base = `CPU ${fmtPct(cpu)} · ${ramTxt} · Disk ${fmtPct(disk)}.`;
    if (!ok) return { status: "Critical", summary: `No se pudo leer el snapshot del sistema. ${base}`, nextStep: "Revisa el bridge y reintenta." };
    if (hot) return { status: "Critical", summary: `Recursos críticos. ${base}`, nextStep: "Investiga procesos pesados de inmediato." };
    if (warm) return { status: "Warning", summary: `Recursos elevados. ${base}`, nextStep: "Vigila la carga; abre System Stability Monitor para más contexto." };
    if (ram === null) return { status: "Warning", summary: `RAM unknown — CPU y Disk normales. ${base}`, nextStep: "" };
    return { status: "OK", summary: `Recursos normales. ${base}`, nextStep: "" };
  }
  if (action === "gateway-status") {
    return ok
      ? { status: "OK", summary: "El gateway link responde correctamente.", nextStep: "" }
      : { status: "Critical", summary: "El gateway link está degradado o inalcanzable.", nextStep: "Re-ejecuta diagnostic para confirmar si el problema es bridge o gateway." };
  }
  if (action === "status") {
    return ok
      ? { status: "OK", summary: "El estado general del agente respondió correctamente.", nextStep: "" }
      : { status: "Warning", summary: "El agente no devolvió un status limpio.", nextStep: "Revisa logs y health." };
  }
  if (action === "logs") {
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? "");
    // Strip benign noise so we don't false-positive on "error: null" etc.
    const benign = [
      /[^\n]*\berror\s*:\s*null[^\n]*/gi,
      /[^\n]*"error"\s*:\s*null[^\n]*/gi,
      /[^\n]*last\s*error\s*:\s*(unknown|null|none)[^\n]*/gi,
      /[^\n]*no\s+(critical\s+)?errors?\s+found[^\n]*/gi,
      /[^\n]*\bENOENT\b[^\n]*/gi,
      /[^\n]*no such file or directory[^\n]*/gi,
      /[^\n]*heartbeat[-_]?_meta[^\n]*/gi,
      /[^\n]*\[tools\]\s*read\s+failed[^\n]*/gi,
    ];
    let scrubbed = text;
    for (const re of benign) scrubbed = scrubbed.replace(re, "");
    const realErrSignals = [
      /logLevelName"?\s*:\s*"?ERROR/i, /\bFATAL\b/i, /\bexception\b/i,
      /connection refused/i, /\btimeout\b/i, /\b5\d{2}\b/, /\bfailed\b/i,
    ];
    const realWarnSignals = [/logLevelName"?\s*:\s*"?WARN/i, /\bWARNING\b/i, /\bdegraded\b/i];
    const hasErr = realErrSignals.some((re) => re.test(scrubbed));
    const hasWarn = realWarnSignals.some((re) => re.test(scrubbed));
    if (hasErr) return { status: "Critical", summary: "Se encontraron errores recientes en los logs.", nextStep: "Revisa System Logs → Errors." };
    if (hasWarn) return { status: "Warning", summary: "Hay warnings recientes en los logs, pero no errores críticos.", nextStep: "Revisa System Logs → Warnings." };
    return { status: "OK", summary: "No hay errores ni warnings notables en los logs recientes.", nextStep: "" };
  }
  // Fallback (shouldn't be reached for the explicit actions above).
  return { status: ok ? "OK" : "Warning", summary: ok ? "Acción completada." : "La acción no respondió limpio.", nextStep: "" };
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
  _logs: BridgeCallResult,
): { status: ConvoStatus; summary: string; nextStep: string } => {
  const cpu = findNum(system.body, /^cpu([_-]?(pct|percent|usage|load))?$/i);
  const ram = findRamPercent(system.body);
  const disk = findNum(system.body, /^(disk|storage)([_-]?(pct|percent|usage))?$/i);

  const bridgeOk = health.ok;
  const gatewayOk = gateway.ok;
  const sysOk = system.ok;

  // Reuse telegram analyzer for a coherent verdict on Telegram.
  const tg = buildTelegramSummary(health, telegram, _logs);
  const tgPartial = tg.status === "Warning";
  const tgCritical = tg.status === "Critical";

  const hot = [cpu, disk].some((v) => typeof v === "number" && v >= 90)
           || (typeof ram === "number" && ram >= 90);
  const warm = [cpu, disk].some((v) => typeof v === "number" && v >= 75)
            || (typeof ram === "number" && ram >= 75);

  const cpuTxt  = `CPU ${fmtPct(cpu)}`;
  const diskTxt = `Disk ${fmtPct(disk)}`;
  const ramTxt  = ram === null ? "RAM unknown" : `RAM ${fmtPct(ram)}`;

  let status: ConvoStatus = "OK";
  if (!bridgeOk || !gatewayOk || !sysOk || hot || tgCritical) status = "Critical";
  else if (tgPartial || warm) status = "Warning";

  const parts: string[] = [];
  parts.push(`Bridge ${bridgeOk ? "OK" : "DOWN"}`);
  parts.push(`Gateway ${gatewayOk ? "OK" : "DEGRADED"}`);
  parts.push(`Telegram ${tgCritical ? "Critical" : tgPartial ? "Partial OK" : "OK"}`);
  if (ram === null && !hot && !warm) {
    parts.push(`${cpuTxt} y ${diskTxt} normales, RAM unknown`);
  } else {
    parts.push(`${cpuTxt} · ${ramTxt} · ${diskTxt}`);
  }

  const summary = `${parts.join(". ")}.`;
  const nextStep = status === "Critical"
    ? "Abre el System Stability Monitor y el Alert Center ahora."
    : status === "Warning"
    ? "No hay acción urgente; revisa warnings si quieres confirmar."
    : "";

  return { status, summary, nextStep };
};

// Alerts summary (lightweight overview based on the same probes).
const buildAlertsSummary = (
  health: BridgeCallResult,
  system: BridgeCallResult,
  gateway: BridgeCallResult,
  telegram: BridgeCallResult,
  logs: BridgeCallResult,
): { status: ConvoStatus; summary: string; nextStep: string } => {
  const alerts: { sev: "CRIT" | "WARN" | "INFO"; msg: string }[] = [];
  if (!health.ok) alerts.push({ sev: "CRIT", msg: "Bridge health probe failed." });
  if (!gateway.ok) alerts.push({ sev: "CRIT", msg: "Gateway link probe failed." });
  if (!system.ok) alerts.push({ sev: "CRIT", msg: "System snapshot probe failed." });

  const tg = buildTelegramSummary(health, telegram, logs);
  if (tg.status === "Critical") alerts.push({ sev: "CRIT", msg: tg.summary });
  else if (tg.status === "Warning") alerts.push({ sev: "WARN", msg: tg.summary });

  const ram = findRamPercent(system.body);
  if (ram === null) alerts.push({ sev: "INFO", msg: "RAM usage unknown — CPU and Disk evaluated independently." });
  else if (ram > 90) alerts.push({ sev: "CRIT", msg: `RAM critical (${Math.round(ram)}%).` });
  else if (ram >= 75) alerts.push({ sev: "WARN", msg: `RAM elevated (${Math.round(ram)}%).` });

  const text = typeof logs.body === "string" ? logs.body : JSON.stringify(logs.body ?? "");
  if (/logLevelName"?\s*:\s*"?WARN/i.test(text) || /\bWARNING\b/i.test(text)) {
    alerts.push({ sev: "WARN", msg: "Recent warnings found in logs." });
  }

  const counts = { CRIT: 0, WARN: 0, INFO: 0 };
  for (const a of alerts) counts[a.sev]++;

  let status: ConvoStatus = "OK";
  if (counts.CRIT > 0) status = "Critical";
  else if (counts.WARN > 0) status = "Warning";

  if (alerts.length === 0) {
    return { status: "OK", summary: "No hay alertas activas. El sistema parece estable.", nextStep: "" };
  }

  const summary =
    `${counts.CRIT} Crit · ${counts.WARN} Warn · ${counts.INFO} Info. ` +
    alerts.slice(0, 3).map((a) => `[${a.sev}] ${a.msg}`).join(" ");
  const nextStep = "Abre el Alert Center en el Dashboard para el detalle completo.";
  return { status, summary, nextStep };
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
      const refusal = conversational({
        status: "Blocked",
        summary: "Esta acción no está permitida desde Command Chat. Solo diagnósticos seguros read-only están habilitados.",
        nextStep: "Usa health, system, gateway, logs, diagnostic, telegram, stability o alerts.",
      });
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
      reply = conversational({
        status: "Blocked",
        summary: "No pude mapear ese mensaje a un diagnóstico seguro.",
        nextStep: "Prueba: 'check health', 'system', 'gateway', 'logs', 'diagnostic', 'telegram', 'stability' o 'alerts'.",
      });
    } else if (action === "diagnostic") {
      const order: Array<Exclude<BridgeAction, "diagnostic" | "telegram-status" | "stability" | "alerts">> = [
        "health", "system", "gateway-status", "status",
      ];
      calls = await Promise.all(
        order.map((a) => callBridge(VPS_BASE, BRIDGE_ROUTES[a], bridgeToken)),
      );
      const allOk = calls.every((c) => c.ok);
      const failed = calls
        .map((c, i) => ({ name: order[i], ok: c.ok }))
        .filter((x) => !x.ok)
        .map((x) => x.name)
        .join(", ");
      reply = conversational({
        status: allOk ? "OK" : "Critical",
        summary: allOk
          ? "Bridge, system, gateway y status respondieron limpio."
          : `Una o más probes fallaron (${failed || "varias"}).`,
        nextStep: allOk
          ? ""
          : "Ejecuta 'stability' para el veredicto consolidado o 'alerts' para acciones concretas.",
        raw: calls,
        wantsRaw,
      });
    } else if (action === "telegram-status") {
      const [h, s, l] = await Promise.all([
        callBridge(VPS_BASE, "/api/openclaw/health", bridgeToken),
        callBridge(VPS_BASE, "/api/openclaw/status", bridgeToken),
        callBridge(VPS_BASE, "/api/openclaw/logs?lines=100", bridgeToken),
      ]);
      calls = [h, s, l];
      const tg = buildTelegramSummary(h, s, l);
      reply = conversational({ ...tg, raw: calls, wantsRaw });
    } else if (action === "stability") {
      const [h, sys, gw, tg, lg] = await Promise.all([
        callBridge(VPS_BASE, "/api/openclaw/health", bridgeToken),
        callBridge(VPS_BASE, "/api/openclaw/system", bridgeToken),
        callBridge(VPS_BASE, "/api/openclaw/gateway-status", bridgeToken),
        callBridge(VPS_BASE, "/api/openclaw/status", bridgeToken),
        callBridge(VPS_BASE, "/api/openclaw/logs?lines=100", bridgeToken),
      ]);
      calls = [h, sys, gw, tg, lg];
      const s = buildStabilitySummary(h, sys, gw, tg, lg);
      reply = conversational({ ...s, raw: calls, wantsRaw });
    } else if (action === "alerts") {
      const [h, sys, gw, tg, lg] = await Promise.all([
        callBridge(VPS_BASE, "/api/openclaw/health", bridgeToken),
        callBridge(VPS_BASE, "/api/openclaw/system", bridgeToken),
        callBridge(VPS_BASE, "/api/openclaw/gateway-status", bridgeToken),
        callBridge(VPS_BASE, "/api/openclaw/status", bridgeToken),
        callBridge(VPS_BASE, "/api/openclaw/logs?lines=100", bridgeToken),
      ]);
      calls = [h, sys, gw, tg, lg];
      const a = buildAlertsSummary(h, sys, gw, tg, lg);
      reply = conversational({ ...a, raw: calls, wantsRaw });
    } else {
      const path = BRIDGE_ROUTES[action];
      const r = await callBridge(VPS_BASE, path, bridgeToken);
      calls = [r];
      // Quick-action buttons (body.action present) keep the legacy raw format
      // so the existing diagnostic panels stay intact.
      if (body.action) {
        reply = formatResult(action.toUpperCase(), r);
      } else {
        const n = naturalize(action, r);
        reply = conversational({ ...n, raw: calls, wantsRaw });
      }
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
