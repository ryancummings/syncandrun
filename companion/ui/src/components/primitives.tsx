import type { ReactNode } from "react";

export function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="section-label">{children}</p>;
}

export function Notice({ tone = "info", children }: { tone?: "info" | "error"; children: ReactNode }) {
  return <p className={tone === "error" ? "notice notice-error" : "notice notice-info"} role={tone === "error" ? "alert" : undefined}>{children}</p>;
}
