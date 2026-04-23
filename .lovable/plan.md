
# OPENCLAW CONTROL — Mobile-First PWA

A dark-mode tactical control panel for the OpenClaw agent, with Supabase auth, persisted skills, real-time activity logs, and a scaffolded VPS bridge.

## What you'll get

**Visual system**
- Background `#0a0a0a`, surfaces `#141414`, borders `#1f1f1f`
- Accents: electric blue `#00d2ff` (active/interactive), neon green `#39FF14` (online/system)
- Fonts: JetBrains Mono (data, logs, commands), Inter (menus, body)
- Subtle glow on active buttons/cards via box-shadow with the accent color
- Mobile-first layout (your viewport is 835×617) — tab bar always visible at bottom, sidebar slides in from the left

**Shell & navigation**
- Top bar: hamburger (left, opens sidebar drawer), title "OPENCLAW CONTROL", green pulse "SYSTEM ACTIVE" indicator (right)
- Left sidebar (drawer): circular avatar, "OPERATOR_01", green dot + "SYSTEM ACTIVE", separator, links to all 5 sections, footer text `v2.4.0-STABLE`
- Bottom tab bar: Dashboard · Models · Chat · Skills · Activity (with icons + glow on active)

**Pages**

1. `/` Dashboard — quick stats: agent status, active model, skills enabled count, recent log count, "Open Chat" CTA
2. `/chat` — message list with two bubble styles (operator = blue-tinted right; agent = dark left, labeled `OPENCLAW_AGENT_V2.4`); quick-action chips "Full Diagnostic" and "System Logs"; bottom command bar with placeholder `TRANSMIT_COMMAND_TO_AGENT...` and a glowing send button
3. `/models` — "NEURAL ARCHITECTURES" header, cards:
   - **GEMINI 3.1 PRO** (active, blue glow) — Latency: Medium · Context: 2M · Multimodal: Full
   - **GEMINI 3.1 FLASH** — Latency: Ultra-Low · Context: 1M · Multimodal: Partial
   - Tap to set active (persisted)
4. `/skills` — grid of toggle cards: **WEB SEARCH**, **PYTHON INTERPRETER** (+ a couple of placeholders like File System, Vision); state persisted per operator in Supabase, sent as flags with chat commands
5. `/activity` — terminal-style log feed (monospace, timestamp · level · source · message), filter chips ALL/SYSTEM/MODEL/SKILL/TERMINAL, red "PURGE LOGS" button with confirm; live-updates via Supabase Realtime

**Auth (single pre-seeded operator)**
- Email/password login page; first time loaded, `Richard Berrios-Irizarry` profile is seeded
- Login route public; everything else gated. After login, profile shows OPERATOR_01 / Richard

**Backend (Lovable Cloud / Supabase)**

Tables:
- `profiles` (id → auth.users, display_name, callsign, avatar_url) — RLS: own row
- `operator_settings` (user_id PK, active_model_id, updated_at) — RLS: own row
- `skills` (id, slug, label, description) — public read
- `operator_skills` (user_id, skill_id, enabled) — RLS: own rows
- `activity_logs` (id, user_id, level, source enum: SYSTEM/MODEL/SKILL/TERMINAL, message, created_at) — RLS: own rows; Realtime enabled
- `chat_messages` (id, user_id, role enum: operator/agent, content, model, created_at) — RLS: own rows

Seeds:
- Profile: Richard Berrios-Irizarry / OPERATOR_01
- Skills: WEB SEARCH, PYTHON INTERPRETER, FILE SYSTEM, VISION
- ~15 realistic activity logs across all 4 sources for visual richness

**VPS bridge (scaffold only)**
- Edge Function `openclaw-agent` reads secret `OPENCLAW_API_KEY`, accepts `{ command, model, skills[] }`, currently returns a stubbed agent response and writes a TERMINAL log entry. Includes a `TODO` block with the real `https://<vps>:18789` call ready to drop in once you share the endpoint contract.
- Secret request will appear after you approve the plan.

**PWA**
- Web manifest with name "OPENCLAW CONTROL", short_name "OPENCLAW", `display: standalone`, theme `#0a0a0a`, accent `#00d2ff`, icons (192/512)
- Apple touch icon + status bar meta for iOS install
- No service worker (per Lovable guidance — keeps preview reliable; the manifest alone makes it installable to the home screen)

## Technical notes

- React + Vite + Tailwind + shadcn/ui; React Router with routes above plus `/login`
- Tailwind tokens extended in `index.css` + `tailwind.config.ts`: `--background`, `--surface`, `--accent` (HSL of #00d2ff), `--success` (HSL of #39FF14), `--border`, custom `glow-accent` / `glow-success` utilities (box-shadow)
- Fonts loaded via Google Fonts in `index.html` (Inter + JetBrains Mono)
- Layout component wraps protected routes: `<TopBar /> <SidebarDrawer /> <Outlet /> <BottomTabBar />`
- `useOperator()` hook → profile + settings; `useSkills()` → toggles with optimistic update; `useActivityLogs()` → initial fetch + `supabase.channel().on('postgres_changes', ...)` subscription
- Chat send flow: insert operator message → invoke `openclaw-agent` Edge Function → insert agent reply + log entry → UI updates via local state and realtime
- Auth gate: `<RequireAuth>` wrapper; `onAuthStateChange` listener set up before `getSession()`
- All HSL color tokens; no hardcoded hex in components

## Build order

```text
1. Cloud + tables + RLS + seeds + realtime on activity_logs
2. Design tokens (colors, fonts, glow utilities)
3. Auth: /login page + RequireAuth + seed Richard's profile
4. App shell: TopBar, SidebarDrawer, BottomTabBar, routing
5. Dashboard page (stats from tables)
6. Models page (active selection persisted)
7. Skills page (toggles persisted)
8. Chat page (bubbles, quick actions, command bar)
9. Activity page (terminal feed, filters, purge, realtime)
10. Edge Function openclaw-agent (scaffold) + secret request
11. PWA manifest + icons + iOS meta
```

## Out of scope (ask if you want these)

- Real VPS endpoint integration (will wire when you share URL + contract)
- Multi-operator management / roles
- Offline service worker / push notifications
