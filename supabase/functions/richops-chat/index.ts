// RichOps chat — thin proxy to the OpenClaw bridge POST /api/openclaw/chat.
// The bridge owns conversation + safety. This function only forwards the
// last user message and surfaces { reply } back to the UI.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const REFUSAL =
  "REQUEST BLOCKED — This action must be performed manually from the VPS terminal.";

interface ChatRequest {
  messages: { role: "user" | "assistant"; content: string }[];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { messages } = (await req.json()) as ChatRequest;
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: "messages required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const last = messages[messages.length - 1];
    const userMessage = String(last?.content ?? "").trim();
    if (!userMessage) {
      return new Response(JSON.stringify({ error: "empty message" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const base = Deno.env.get("OPENCLAW_BRIDGE_URL");
    const token = Deno.env.get("OPENCLAW_BRIDGE_TOKEN");
    if (!base || !token) {
      return new Response(
        JSON.stringify({ error: "Bridge not configured (URL or token missing)." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const normalizedBase = base.replace(/\/+$/, "");
    const parsedBase = new URL(normalizedBase);
    const basePath = parsedBase.pathname.replace(/\/+$/, "");

    if (basePath) {
      return new Response(
        JSON.stringify({
          error: "Bridge misconfigured: OPENCLAW_BRIDGE_URL must be the bridge base URL only.",
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const url = `${normalizedBase}/api/openclaw/chat`;
    console.log("[richops-chat] POST", url.replace(/\/\/[^/]+/, "//***"));
    let bridgeResp: Response;
    try {
      bridgeResp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
          "Accept": "application/json",
        },
        body: JSON.stringify({ message: userMessage }),
      });
    } catch (e) {
      return new Response(
        JSON.stringify({ error: `Bridge unreachable: ${String((e as Error).message ?? e)}` }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const text = await bridgeResp.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch { /* keep raw */ }

    console.log("[richops-chat] bridge status:", bridgeResp.status, "ok:", (data as any)?.ok);

    // Success: bridge ok + reply → forward verbatim, always 200.
    if (data && typeof data === "object" && data.ok === true && typeof data.reply === "string") {
      return new Response(
        JSON.stringify({ reply: data.reply, runId: data.runId, sessionKey: data.sessionKey }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Explicit block from the bridge.
    const errStr = String(data?.error ?? "");
    const statusStr = String(data?.status ?? "");
    if (errStr.includes("REQUEST BLOCKED") || statusStr.toLowerCase().includes("blocked")) {
      return new Response(
        JSON.stringify({ reply: REFUSAL, blocked: true }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Anything else: surface the bridge's message as a normal reply (200) so the UI can render it.
    const fallback =
      (typeof data === "object" && (data?.reply || data?.error || data?.status)) ||
      (typeof data === "string" && data) ||
      `No response from bridge (HTTP ${bridgeResp.status})`;

    return new Response(
      JSON.stringify({ reply: `⚠️ Bridge HTTP ${bridgeResp.status}: ${String(fallback)}` }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: String((e as Error).message ?? e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
