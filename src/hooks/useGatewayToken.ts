import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "openclaw.gateway_token";

const readToken = (): string => {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
};

export function useGatewayToken() {
  const [token, setTokenState] = useState<string>(() => readToken());

  // Sync across tabs / windows
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setTokenState(e.newValue ?? "");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setToken = useCallback((value: string) => {
    const trimmed = value.trim();
    try {
      if (trimmed) window.localStorage.setItem(STORAGE_KEY, trimmed);
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    setTokenState(trimmed);
  }, []);

  const clearToken = useCallback(() => setToken(""), [setToken]);

  return { token, setToken, clearToken, hasToken: token.length > 0 };
}

export const getGatewayToken = readToken;
