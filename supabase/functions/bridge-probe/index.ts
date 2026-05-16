// One-off diagnostic: probe several chat-path variants on the bridge.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const base = (Deno.env.get("OPENCLAW_BRIDGE_URL") || "").replace(/\/$/, "");
  const token = Deno.env.get("OPENCLAW_BRIDGE_TOKEN") || "";
  const baseShown = base.replace(/\/\/[^/]+/, "//***");

  const paths = [
    "/api/openclaw/chat",
    "/api/openclaw/health",
    "/api/chat",
    "/chat",
    "/api/openclaw",
  ];

  const out: any[] = [];
  for (const p of paths) {
    for (const method of ["POST", "GET"]) {
      try {
        const r = await fetch(`${base}${p}`, {
          method,
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
            "Accept": "application/json",
          },
          body: method === "POST" ? JSON.stringify({ message: "ping" }) : undefined,
        });
        const t = await r.text();
        out.push({ path: p, method, status: r.status, body: t.slice(0, 200) });
      } catch (e) {
        out.push({ path: p, method, error: String((e as Error).message ?? e) });
      }
    }
  }
  return new Response(JSON.stringify({ base: baseShown, results: out }, null, 2), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
