import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";

export type Profile = {
  id: string;
  display_name: string;
  callsign: string;
  status: string;
  avatar_url: string | null;
};

export type ModelRow = {
  id: string;
  slug: string;
  name: string;
  latency: string;
  context: string;
  multimodal: string;
  description: string | null;
  sort_order: number;
};

export function useOperator() {
  const { user } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [activeModel, setActiveModel] = useState<ModelRow | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    if (!user) {
      setProfile(null);
      setActiveModel(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const [{ data: prof }, { data: settings }] = await Promise.all([
      supabase.from("profiles").select("*").eq("id", user.id).maybeSingle(),
      supabase.from("operator_settings").select("active_model_id").eq("user_id", user.id).maybeSingle(),
    ]);
    setProfile(prof as Profile | null);
    if (settings?.active_model_id) {
      const { data: m } = await supabase.from("models").select("*").eq("id", settings.active_model_id).maybeSingle();
      setActiveModel(m as ModelRow | null);
    }
    setLoading(false);
  };

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [user?.id]);

  return { profile, activeModel, loading, refresh };
}
