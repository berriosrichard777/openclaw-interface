import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
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
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims(token);
    if (claimsError || !claimsData?.claims) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = claimsData.claims.sub;

    const body = (await req.json()) as AgentRequest;
    if (!body?.command || typeof body.command !== "string") {
      return new Response(JSON.stringify({ error: "command required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const apiKey = Deno.env.get("OPENCLAW_API_KEY");
    let reply: string;

    if (apiKey) {
      // TODO: Wire up real VPS bridge once endpoint contract is provided.
      // const VPS_BASE = "https://<your-vps-host>:18789";
      // const upstream = await fetch(`${VPS_BASE}/agent/command`, {
      //   method: "POST",
      //   headers: {
      //     "Authorization": `Bearer ${apiKey}`,
      //     "Content-Type": "application/json",
      //   },
      //   body: JSON.stringify({
      //     model: body.model,
      //     skills: body.skills ?? [],
      //     command: body.command,
      //     operator_id: userId,
      //   }),
      // });
      // const data = await upstream.json();
      // reply = data.reply ?? "(no reply)";
      reply = stubReply(body);
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
