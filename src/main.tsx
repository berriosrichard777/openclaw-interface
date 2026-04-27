import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

// SECURITY: purge any previously stored bridge/gateway token from the
// browser. The token is now backend-only (OPENCLAW_BRIDGE_TOKEN secret).
try {
  localStorage.removeItem("openclaw.gateway_token");
} catch {
  /* ignore */
}

createRoot(document.getElementById("root")!).render(<App />);
