// RichOps conversational chat — read-only, no bridge access.
// Uses Lovable AI Gateway. Refuses dangerous/write/secret-leaking requests.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const FORBIDDEN_PATTERNS: RegExp[] = [
  /\bdelete\b/i, /\brm\s+-/i, /\bdrop\s+table\b/i, /\bpurge\b/i,
  /\brestart\b/i, /\breboot\b/i, /\bshutdown\b/i, /\bkill\b/i,
  /\bstop\s+(server|service|bot|gateway|telegram|docker|bridge)\b/i,
  /\bdocker(\s|[-_]compose)/i, /\bkubectl\b/i, /\bsystemctl\b/i, /\bsudo\b/i,
  /\b(shell|bash)\b/i, /\bsh\s+-c\b/i,
  /\bedit\s+(config|env|secret|token)\b/i,
  /\bchange\s+(token|secret|password|config)\b/i,
  /\b(show|expose|reveal|print|leak|dump|give\s+me)\s+(the\s+)?(token|secret|password|api[_-]?key|env|credential)/i,
  /\bcloudflare\b/i, /\bfirewall\b/i,
];

const REFUSAL =
  "Esa acción no está permitida desde Chat. Para diagnósticos reales del sistema usa **Command Chat** (read-only, conectado al bridge). Yo aquí solo converso y oriento.";

const SYSTEM_PROMPT = `You are **RichOps**, a friendly conversational assistant for the OpenClaw operator console.

ROLE:
- You are conversational only. You CAN explain concepts, interpret states, help the user understand outputs, and orient them through the app.
- You CANNOT execute any real system command, touch the VPS, Docker, shell, Cloudflare, filesystem, tokens, secrets, or config.
- You have NO access to live bridge data. If the user wants real diagnostics (health, system, logs, telegram, alerts, uptime, etc.), tell them to switch to **Command Chat**.

LANGUAGE:
- Mirror the user's language. Spanish in → Spanish out. English in → English out.

STYLE:
- Concise, warm, technical when needed. Mono-friendly. Use short paragraphs and lists.
- Never invent live metrics. If asked "how is the server right now?", say you don't have live access and point to Command Chat.

SAFETY:
- Never reveal, guess, or echo tokens, secrets, API keys, env vars, or passwords.
- If asked to restart, delete, run docker/shell, edit config, or any write-action, refuse politely and suggest Command Chat for read-only diagnostics.`;

interface ChatMessage { role: "user" | "assistant"; content: string }
interface ChatRequest { messages: ChatMessage[] }

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

    const aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...trimmed],
      }),
    });

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
    const reply = data?.choices?.[0]?.message?.content ?? "(sin respuesta)";

    return new Response(JSON.stringify({ reply, model: "google/gemini-2.5-flash" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message ?? e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
