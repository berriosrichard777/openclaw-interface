import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

Deno.serve((req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const url = Deno.env.get("OPENCLAW_BRIDGE_URL") ?? "";
  const token = Deno.env.get("OPENCLAW_BRIDGE_TOKEN") ?? "";
  return new Response(
    JSON.stringify({
      bridge_url: url,
      bridge_url_set: url.length > 0,
      bridge_url_matches_expected: url === "https://bridge.richops.cloud",
      bridge_url_is_old: url.includes("ai.richops.cloud"),
      token_set: token.length > 0,
      token_length: token.length,
      token_preview: token ? `${token.slice(0, 3)}***${token.slice(-2)}` : "",
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
