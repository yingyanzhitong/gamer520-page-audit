import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export function formatDate(value, withTime = true) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    ...(withTime
      ? {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }
      : {}),
  }).format(date);
}

export function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value ?? 0));
}

export function statusTone(status) {
  if (["success", "published", "synced"].includes(status)) return "success";
  if (["failed", "unknown", "violation"].includes(status)) return "danger";
  if (["running", "publishing"].includes(status)) return "info";
  if (["partial", "interrupted", "updated", "missing"].includes(status)) return "warning";
  return "neutral";
}
