/**
 * Parses a timestamp that may be an ISO string or SQLite's default
 * "YYYY-MM-DD HH:MM:SS" format (which has no timezone and is stored as UTC).
 */
function parseTimestamp(iso: string): Date {
  let normalized = iso.trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(normalized)) {
    normalized = normalized.replace(" ", "T");
  }
  if (/T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(normalized)) {
    normalized += "Z";
  }
  return new Date(normalized);
}

/**
 * Renders a human-friendly "time ago" string, e.g. "3h ago", "just now".
 */
export function timeAgo(iso: string): string {
  const date = parseTimestamp(iso);
  const ms = Date.now() - date.getTime();
  if (Number.isNaN(ms)) return "unknown";

  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 45) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Renders a short absolute date, e.g. "Aug 20, 2026", for display alongside
 * relative times.
 */
export function formatDate(iso: string): string {
  const date = parseTimestamp(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
