import { useEffect, useState } from "react";

function readRoute(): string {
  const hash = window.location.hash.replace(/^#/, "");
  const path = hash.split("?")[0];
  return path === "" ? "/" : path;
}

export function useHashRoute(): string {
  const [route, setRoute] = useState<string>(readRoute());

  useEffect(() => {
    const onHashChange = () => setRoute(readRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return route;
}

/** Navigates to a hash route, e.g. `navigate("/login?next=%2Fmanage")`. */
export function navigate(path: string): void {
  window.location.hash = path;
}

/** Parses the query string portion of the current hash (after the first `?`). */
export function readHashQuery(): URLSearchParams {
  const hash = window.location.hash.replace(/^#/, "");
  const queryIndex = hash.indexOf("?");
  return new URLSearchParams(queryIndex === -1 ? "" : hash.slice(queryIndex + 1));
}
