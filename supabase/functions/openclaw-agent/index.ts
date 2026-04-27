import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { createClient } from "npm:@supabase/supabase-js@2.49.8";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-gateway-token, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface AgentRequest {
  command: string;
  model?: string;
  skills?: string[];
}

const stubReply = (body: AgentRequest) => {
  const skills = body.skills?.length ? body.skills.join(", ") : "none";
  const cmd = body.command.trim();
  if (/diagnostic/i.test(cmd)) {
    return [
      "DIAGNOSTIC SWEEP COMPLETE.",
      "  • CORE      :: NOMINAL",
      "  • MEMORY    :: 64% utilized",
      "  • GATEWAY   :: STAND-BY (port 18789)",
      "  • SKILLS    :: " + skills,
      "  • LATENCY   :: 142ms p50",
      "ALL SYSTEMS GREEN.",
    ].join("\n");
  }
  if (/log/i.test(cmd)) {
    return "Streaming last system events... see ACTIVITY tab for full feed.";
  }
  return `ACK :: command received via ${body.model ?? "default"}.\n> ${cmd}\nResponse pending VPS bridge (stub mode).`;
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
    const apiKey =
      headerToken ||
      Deno.env.get("OPENCLAW_BRIDGE_TOKEN") ||
      Deno.env.get("OPENCLAW_API_KEY");

    // Base URL: prefer OPENCLAW_BRIDGE_URL secret, fall back to legacy default.
    const VPS_BASE = (Deno.env.get("OPENCLAW_BRIDGE_URL") ?? "https://ai.richops.cloud")
      .replace(/\/+$/, "");
    let reply: string;

    if (apiKey) {
      try {
        const upstream = await fetch(`${VPS_BASE}/agent/command`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: body.model,
            skills: body.skills ?? [],
            command: body.command,
            operator_id: userId,
          }),
        });

        if (!upstream.ok) {
          const errText = await upstream.text();
          console.error("VPS bridge error", upstream.status, errText);
          reply = `BRIDGE ERROR :: ${upstream.status} :: ${errText.slice(0, 200)}`;
        } else {
          const data = await upstream.json();
          reply = data.reply ?? data.message ?? "(no reply from VPS)";
        }
      } catch (fetchErr) {
        console.error("VPS bridge fetch failed", fetchErr);
        reply = `BRIDGE UNREACHABLE :: ${(fetchErr as Error).message}`;
      }
    } else {
      reply = stubReply(body);
    }

    // Log a TERMINAL event for traceability.
    await supabase.from("activity_logs").insert({
      user_id: userId,
      source: "TERMINAL",
      level: "INFO",
      message: `command :: ${body.command.slice(0, 120)}`,
    });

    return new Response(
      JSON.stringify({ reply, model: body.model, agent: "OPENCLAW_AGENT_V2.4" }),
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
