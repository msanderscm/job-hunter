import { useCallback, useState } from "react";
import { ApiError } from "../api";

const PROMPT_MESSAGE = "Admin token (ADMIN_TOKEN secret)";

export interface UseAdminToken {
  token: string | null;
  ensureToken: () => string | null;
  clearToken: () => void;
  /**
   * Runs `fn` with a valid admin token. If the token is missing, prompts for
   * it first. If the call fails with a 401, clears the stored token,
   * re-prompts once, and retries. If it's still unauthorized (or the user
   * cancels the prompt), the error/rejection propagates to the caller.
   */
  withAuth: <T>(fn: (token: string) => Promise<T>) => Promise<T>;
}

export function useAdminToken(): UseAdminToken {
  const [token, setToken] = useState<string | null>(null);

  const ensureToken = useCallback((): string | null => {
    if (token) return token;
    const entered = window.prompt(PROMPT_MESSAGE);
    if (!entered) return null;
    setToken(entered);
    return entered;
  }, [token]);

  const clearToken = useCallback(() => setToken(null), []);

  const withAuth = useCallback(
    async <T,>(fn: (token: string) => Promise<T>): Promise<T> => {
      const current = token ?? window.prompt(PROMPT_MESSAGE);
      if (!current) {
        throw new ApiError(401, "Admin token required");
      }
      if (current !== token) setToken(current);

      try {
        return await fn(current);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          setToken(null);
          const retry = window.prompt(PROMPT_MESSAGE);
          if (!retry) {
            throw err;
          }
          setToken(retry);
          return await fn(retry);
        }
        throw err;
      }
    },
    [token]
  );

  return { token, ensureToken, clearToken, withAuth };
}
