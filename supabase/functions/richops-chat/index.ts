// RichOps conversational chat — read-only agent with bridge context.
//
// SECURITY MODEL
// - Token (OPENCLAW_BRIDGE_TOKEN) NEVER leaves this function. The frontend
//   has zero awareness of it.
// - The model can only invoke a single tool: `get_bridge_status(action)`.
//   The action argument is constrained by a strict allowlist (read-only).
// - Any user message matching FORBIDDEN_PATTERNS is refused immediately with
//   the canonical REQUEST BLOCKED line. The model is never consulted in that
//   case, so it cannot be jail-broken into emitting destructive guidance.
// - All bridge calls are GET-only. No body, no write verbs.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ---------- Hard refusal ---------------------------------------------------

const FORBIDDEN_PATTERNS: RegExp[] = [
  /\bdelete\b/i, /\bremove\s+files?\b/i, /\brm\s+-/i, /\bdrop\s+table\b/i, /\bpurge\b/i,
  /\brestart\b/i, /\breboot\b/i, /\bshutdown\b/i, /\bkill\b/i,
  /\bstop\s+(server|service|bot|gateway|telegram|docker|bridge)\b/i,
  /\bdocker\s+(restart|stop|start|kill|rm|exec|run|build|compose|prune|network|volume|swarm)\b/i,
  /\bdocker[-_]?compose\b/i,
  /\bkubectl\b/i, /\bsystemctl\b/i, /\bsudo\b/i,
  /\b(shell|bash)\b/i, /\bsh\s+-c\b/i,
  /\bedit\s+(config|env|secret|token)\b/i,
  /\bchange\s+(token|secret|password|config)\b/i,
  /\bupdate\s+openclaw\b/i, /\bupgrade\s+openclaw\b/i,
  /\b(show|expose|reveal|print|leak|dump|give\s+me)\s+(the\s+)?(token|secret|password|api[_-]?key|env|credential)/i,
  /\bcloudflare\b/i, /\bfirewall\b/i, /\biptables\b/i,
];

const REFUSAL =
  "REQUEST BLOCKED — This action must be performed manually from the VPS terminal.";

// ---------- Bridge tool ----------------------------------------------------

type BridgeAction =
  | "health" | "system" | "gateway-status" | "status"
  | "logs" | "telegram" | "stability" | "alerts"
  | "uptime" | "network" | "ports" | "containers" | "memory" | "disk";

const BRIDGE_ROUTES: Record<BridgeAction, string> = {
  "health":         "/api/openclaw/health",
  "system":         "/api/openclaw/system",
  "gateway-status": "/api/openclaw/gateway-status",
  "status":         "/api/openclaw/status",
  "logs":           "/api/openclaw/logs?lines=50",
  "telegram":       "/api/openclaw/status",
  "stability":      "/api/openclaw/status",
  "alerts":         "/api/openclaw/logs?lines=100",
  "uptime":         "/api/openclaw/uptime",
  "network":        "/api/openclaw/network",
  "ports":          "/api/openclaw/ports",
  "containers":     "/api/openclaw/docker",
  "memory":         "/api/openclaw/memory",
  "disk":           "/api/openclaw/disk",
};

const ALLOWED_ACTIONS = Object.keys(BRIDGE_ROUTES) as BridgeAction[];

const SENSITIVE_KEY_RE =
  /(token|secret|authorization|api[_-]?key|password|bearer)/i;

// Strip any sensitive-looking keys before handing the payload back to the model.
const sanitize = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(sanitize);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(k)) { out[k] = "[redacted]"; continue; }
      out[k] = sanitize(val);
    }
    return out;
  }
  return v;
};

const callBridge = async (action: BridgeAction): Promise<unknown> => {
  const base = Deno.env.get("OPENCLAW_BRIDGE_URL");
  const token = Deno.env.get("OPENCLAW_BRIDGE_TOKEN");
  if (!base || !token) {
    return { ok: false, error: "Bridge not configured (URL or token missing)." };
  }
  const path = BRIDGE_ROUTES[action];
  const url = `${base.replace(/\/$/, "")}${path}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json" },
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep raw */ }
    if (res.status === 404 || res.status === 501) {
      return { ok: false, status: res.status, note: `Endpoint not available yet on the bridge (${path}).` };
    }
    return { ok: res.ok, status: res.status, endpoint: path, body: sanitize(body) };
  } catch (e) {
    return { ok: false, status: 0, error: String((e as Error).message ?? e) };
  }
};

// ---------- System prompt --------------------------------------------------

const SYSTEM_PROMPT = `You are **RichOps**, the primary conversational assistant for the OpenClaw operator console.

YOUR ROLE
- You speak naturally and helpfully, like an experienced co-pilot for the operator.
- You CAN inspect live OpenClaw state by calling the tool \`get_bridge_status\` (read-only).
- You CANNOT perform any write/destructive action. No restarts, no docker, no shell, no config edits, no token/secret reveal, no OpenClaw upgrades.
- Real diagnostics live in **Command Chat** for raw payloads; here, prefer human-readable explanations and recommendations.

WHEN TO CALL THE TOOL
- Call it whenever the user asks about live state: "how is everything", "is OpenClaw up", "any errors", "telegram status", "cpu/ram", "logs", "alerts", "stability", "gateway", "uptime", "ports", "containers", "memory", "disk".
- For pure conversation, explanation, or guidance — DO NOT call the tool.
- Prefer fewer, focused calls. Combine results in your reply rather than spamming the tool.

RESPONSE FORMAT (when reporting bridge state)
Status: OK | Warning | Critical | Blocked
Summary: short natural-language explanation in the user's language.
Next step: concrete recommendation, or "—" if none.
(Optional) Details: only if the user explicitly asked for raw/details.

LANGUAGE
- Mirror the user's language. Spanish in → Spanish out. English in → English out.

SAFETY (non-negotiable)
- Never reveal, guess, or echo tokens, secrets, API keys, env vars, passwords, bridge URLs, or auth headers.
- If the user requests anything destructive (restart, delete, docker, shell, sudo, edit config, expose secrets, update OpenClaw, write actions), reply with EXACTLY:
  "REQUEST BLOCKED — This action must be performed manually from the VPS terminal."
- Never invent metrics. If the bridge call fails, say so plainly and suggest a retry.`;

// ---------- AI Gateway -----------------------------------------------------

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}
interface ChatRequest { messages: { role: "user" | "assistant"; content: string }[] }

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_bridge_status",
      description:
        "Fetch read-only diagnostic data from the OpenClaw bridge. Use for live state questions (health, system, logs, telegram, alerts, etc.). Never use for write actions.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ALLOWED_ACTIONS,
            description: "Which read-only diagnostic to fetch.",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
];

const callModel = async (apiKey: string, messages: ChatMessage[]) => {
  const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages,
      tools: TOOLS,
      tool_choice: "auto",
    }),
  });
  return resp;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { messages } = (await req.json()) as ChatRequest;
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: "messages required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const last = messages[messages.length - 1];
    if (last?.role === "user" && FORBIDDEN_PATTERNS.some((r) => r.test(last.content))) {
      return new Response(
        JSON.stringify({ reply: REFUSAL, blocked: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const apiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "AI gateway not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Trim history (keep last 20 turns)
    const trimmed = messages.slice(-20);
    const convo: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...trimmed.map((m) => ({ role: m.role, content: m.content })),
    ];

    // Tool-call loop. Cap at 3 iterations to prevent runaway cost.
    let finalReply = "(sin respuesta)";
    for (let i = 0; i < 3; i++) {
      const aiResp = await callModel(apiKey, convo);
      if (aiResp.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit. Try again shortly." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      if (aiResp.status === 402) {
        return new Response(JSON.stringify({ error: "AI credits exhausted. Add funds in workspace settings." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      if (!aiResp.ok) {
        const t = await aiResp.text();
        return new Response(JSON.stringify({ error: `AI gateway error: ${t.slice(0, 200)}` }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const data = await aiResp.json();
      const choice = data?.choices?.[0];
      const msg = choice?.message;
      const toolCalls = msg?.tool_calls as ChatMessage["tool_calls"] | undefined;

      if (toolCalls && toolCalls.length > 0) {
        // Append assistant turn carrying tool_calls, then resolve each call.
        convo.push({ role: "assistant", content: msg.content ?? "", tool_calls: toolCalls });
        for (const call of toolCalls) {
          let result: unknown = { ok: false, error: "Unknown tool." };
          if (call.function?.name === "get_bridge_status") {
            let action: string | undefined;
            try { action = JSON.parse(call.function.arguments || "{}").action; } catch { /* noop */ }
            if (action && (ALLOWED_ACTIONS as string[]).includes(action)) {
              result = await callBridge(action as BridgeAction);
            } else {
              result = { ok: false, error: `Action not allowed: ${action ?? "(none)"}` };
            }
          }
          convo.push({
            role: "tool",
            tool_call_id: call.id,
            name: call.function?.name,
            content: JSON.stringify(result),
          });
        }
        continue; // re-ask the model with tool results
      }

      finalReply = msg?.content ?? "(sin respuesta)";
      break;
    }

    return new Response(
      JSON.stringify({ reply: finalReply, model: "google/gemini-2.5-flash" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message ?? e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
