
-- =========================
-- ENUMS
-- =========================
CREATE TYPE public.log_source AS ENUM ('SYSTEM', 'MODEL', 'SKILL', 'TERMINAL');
CREATE TYPE public.log_level AS ENUM ('INFO', 'WARN', 'ERROR', 'OK');
CREATE TYPE public.message_role AS ENUM ('operator', 'agent');

-- =========================
-- PROFILES
-- =========================
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL DEFAULT 'OPERATOR',
  callsign TEXT NOT NULL DEFAULT 'OPERATOR_01',
  avatar_url TEXT,
  status TEXT NOT NULL DEFAULT 'SYSTEM ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "profiles_select_own" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "profiles_update_own" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id);
CREATE POLICY "profiles_insert_own" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);

-- =========================
-- MODELS (catalog, public read)
-- =========================
CREATE TABLE public.models (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  latency TEXT NOT NULL,
  context TEXT NOT NULL,
  multimodal TEXT NOT NULL,
  description TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.models ENABLE ROW LEVEL SECURITY;
CREATE POLICY "models_select_all" ON public.models FOR SELECT TO authenticated USING (true);

INSERT INTO public.models (slug, name, latency, context, multimodal, description, sort_order) VALUES
  ('gemini-3-1-pro',   'GEMINI 3.1 PRO',   'Medium',    '2M', 'Full',    'Heavy reasoning, deep multimodal grounding.', 1),
  ('gemini-3-1-flash', 'GEMINI 3.1 FLASH', 'Ultra-Low', '1M', 'Partial', 'High-throughput, low-latency tactical responses.', 2);

-- =========================
-- SKILLS (catalog, public read)
-- =========================
CREATE TABLE public.skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  description TEXT NOT NULL,
  icon TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.skills ENABLE ROW LEVEL SECURITY;
CREATE POLICY "skills_select_all" ON public.skills FOR SELECT TO authenticated USING (true);

INSERT INTO public.skills (slug, label, description, icon, sort_order) VALUES
  ('web_search',        'WEB SEARCH',        'Allow agent to query live web sources.',           'globe',   1),
  ('python_interpreter','PYTHON INTERPRETER','Execute sandboxed Python for analysis & math.',     'terminal',2),
  ('file_system',       'FILE SYSTEM',       'Read/write within the operator workspace.',         'folder',  3),
  ('vision',            'VISION',            'Analyze images, diagrams and screenshots.',         'eye',     4);

-- =========================
-- OPERATOR SETTINGS
-- =========================
CREATE TABLE public.operator_settings (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  active_model_id UUID REFERENCES public.models(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.operator_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "settings_select_own" ON public.operator_settings FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "settings_insert_own" ON public.operator_settings FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "settings_update_own" ON public.operator_settings FOR UPDATE TO authenticated USING (auth.uid() = user_id);

-- =========================
-- OPERATOR SKILLS
-- =========================
CREATE TABLE public.operator_skills (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  skill_id UUID NOT NULL REFERENCES public.skills(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, skill_id)
);
ALTER TABLE public.operator_skills ENABLE ROW LEVEL SECURITY;
CREATE POLICY "op_skills_select_own" ON public.operator_skills FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "op_skills_insert_own" ON public.operator_skills FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "op_skills_update_own" ON public.operator_skills FOR UPDATE TO authenticated USING (auth.uid() = user_id);

-- =========================
-- ACTIVITY LOGS
-- =========================
CREATE TABLE public.activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source public.log_source NOT NULL,
  level public.log_level NOT NULL DEFAULT 'INFO',
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "logs_select_own" ON public.activity_logs FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "logs_insert_own" ON public.activity_logs FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "logs_delete_own" ON public.activity_logs FOR DELETE TO authenticated USING (auth.uid() = user_id);
CREATE INDEX activity_logs_user_created_idx ON public.activity_logs(user_id, created_at DESC);
ALTER PUBLICATION supabase_realtime ADD TABLE public.activity_logs;
ALTER TABLE public.activity_logs REPLICA IDENTITY FULL;

-- =========================
-- CHAT MESSAGES
-- =========================
CREATE TABLE public.chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.message_role NOT NULL,
  content TEXT NOT NULL,
  model_slug TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "chat_select_own" ON public.chat_messages FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "chat_insert_own" ON public.chat_messages FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE INDEX chat_messages_user_created_idx ON public.chat_messages(user_id, created_at);

-- =========================
-- TRIGGER: handle_new_user
-- =========================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  default_model_id UUID;
  skill_row RECORD;
BEGIN
  -- Profile
  INSERT INTO public.profiles (id, display_name, callsign, status)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'display_name', 'Richard Berrios-Irizarry'),
    COALESCE(NEW.raw_user_meta_data->>'callsign', 'OPERATOR_01'),
    'SYSTEM ACTIVE'
  );

  -- Settings (default to Gemini 3.1 PRO)
  SELECT id INTO default_model_id FROM public.models WHERE slug = 'gemini-3-1-pro' LIMIT 1;
  INSERT INTO public.operator_settings (user_id, active_model_id)
  VALUES (NEW.id, default_model_id);

  -- Operator skills (all disabled by default, except Web Search ON)
  FOR skill_row IN SELECT id, slug FROM public.skills LOOP
    INSERT INTO public.operator_skills (user_id, skill_id, enabled)
    VALUES (NEW.id, skill_row.id, skill_row.slug = 'web_search');
  END LOOP;

  -- Seed welcome activity logs
  INSERT INTO public.activity_logs (user_id, source, level, message) VALUES
    (NEW.id, 'SYSTEM',   'OK',    'OPERATOR session bootstrapped.'),
    (NEW.id, 'SYSTEM',   'INFO',  'Profile provisioned: OPERATOR_01.'),
    (NEW.id, 'MODEL',    'INFO',  'Default architecture: GEMINI 3.1 PRO.'),
    (NEW.id, 'SKILL',    'OK',    'WEB_SEARCH skill enabled by default.'),
    (NEW.id, 'TERMINAL', 'INFO',  'Gateway link: 127.0.0.1:18789 [stand-by].'),
    (NEW.id, 'SYSTEM',   'INFO',  'RLS policies: VERIFIED.'),
    (NEW.id, 'MODEL',    'OK',    'Context window negotiated: 2M tokens.'),
    (NEW.id, 'TERMINAL', 'INFO',  'Edge runtime warm-up complete.'),
    (NEW.id, 'SKILL',    'INFO',  'PYTHON_INTERPRETER on stand-by.'),
    (NEW.id, 'SYSTEM',   'OK',    'Real-time channel attached: activity_logs.'),
    (NEW.id, 'TERMINAL', 'WARN',  'OPENCLAW_API_KEY not configured (stub mode).'),
    (NEW.id, 'MODEL',    'INFO',  'Multimodal pipeline: nominal.'),
    (NEW.id, 'SYSTEM',   'OK',    'Telemetry sync: NOMINAL.'),
    (NEW.id, 'SKILL',    'INFO',  'FILE_SYSTEM sandbox initialized.'),
    (NEW.id, 'SYSTEM',   'OK',    'OPENCLAW_AGENT_V2.4 ready for command.');

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- =========================
-- TRIGGER: log skill toggles
-- =========================
CREATE OR REPLACE FUNCTION public.log_skill_toggle()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  skill_label TEXT;
BEGIN
  IF NEW.enabled IS DISTINCT FROM OLD.enabled THEN
    SELECT label INTO skill_label FROM public.skills WHERE id = NEW.skill_id;
    INSERT INTO public.activity_logs (user_id, source, level, message)
    VALUES (
      NEW.user_id,
      'SKILL',
      CASE WHEN NEW.enabled THEN 'OK' ELSE 'INFO' END,
      skill_label || CASE WHEN NEW.enabled THEN ' :: ENABLED' ELSE ' :: DISABLED' END
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_skill_toggle
AFTER UPDATE ON public.operator_skills
FOR EACH ROW EXECUTE FUNCTION public.log_skill_toggle();
