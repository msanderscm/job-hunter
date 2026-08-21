import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ApiError, getMe, login as apiLogin, logout as apiLogout } from "./api";
import type { User } from "./api";
import { navigate } from "./hooks/useHashRoute";

type AuthStatus = "loading" | "anon" | "in";

interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  requireLogin: (next?: string) => void;
  /**
   * Runs `fn` if there's a session (or one hasn't been checked yet — the
   * server is authoritative). Redirects to /login on a 401, either up front
   * (already known anon) or after the call fails, then rethrows so the
   * caller's own error handling still runs.
   */
  guard: <T>(fn: () => Promise<T>) => Promise<T>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function currentRoute(): string {
  const hash = window.location.hash.replace(/^#/, "");
  return hash.split("?")[0] || "/";
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    getMe()
      .then((data) => {
        setUser(data.user);
        setStatus("in");
      })
      .catch(() => {
        // 401, or any other failure — don't block the app, just treat as anon.
        setUser(null);
        setStatus("anon");
      });
  }, []);

  const requireLogin = useCallback((next?: string) => {
    const target = next ?? currentRoute();
    navigate(`/login?next=${encodeURIComponent(target)}`);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const { user: loggedInUser } = await apiLogin(username, password);
    setUser(loggedInUser);
    setStatus("in");
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    setUser(null);
    setStatus("anon");
    navigate("/");
  }, []);

  const guard = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      if (status === "anon") {
        requireLogin();
        throw new ApiError(401, "Login required");
      }
      try {
        return await fn();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          setUser(null);
          setStatus("anon");
          requireLogin();
        }
        throw err;
      }
    },
    [status, requireLogin]
  );

  const value: AuthContextValue = { status, user, login, logout, requireLogin, guard };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
