import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

export function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="section-label">{children}</p>;
}

export function Notice({ tone = "info", children }: { tone?: "info" | "error"; children: ReactNode }) {
  return (
    <p className={tone === "error" ? "notice notice-error" : "notice notice-info"} role={tone === "error" ? "alert" : undefined}>
      {children}
    </p>
  );
}

export function Readout({
  label,
  value,
  note,
  primary = false
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  primary?: boolean;
}) {
  return (
    <div className="readout">
      <p className="readout-label">{label}</p>
      <p className={primary ? "readout-value readout-value-primary phosphor" : "readout-value"}>{value}</p>
      {/* Always rendered: a missing note would make one tile shorter than its row. */}
      <p className="readout-note" title={typeof note === "string" ? note : undefined}>
        {note ?? "\u00a0"}
      </p>
    </div>
  );
}

export function Progress({
  ratio,
  label,
  subtle = false
}: {
  ratio: number | null;
  label: string;
  /** A secondary bar (per-track) that must not compete with overall progress. */
  subtle?: boolean;
}) {
  const percent = ratio === null ? null : Math.min(Math.max(ratio, 0), 1) * 100;
  return (
    <div
      className={subtle ? "progress progress-subtle" : "progress"}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent === null ? undefined : Math.round(percent)}
    >
      <div
        className={percent === null ? "progress-fill progress-fill-indeterminate" : "progress-fill"}
        style={percent === null ? undefined : { width: `${percent}%` }}
      />
    </div>
  );
}

/**
 * Two-step destructive action. Replaces `window.confirm`, which cannot be
 * styled and reads as a browser interruption rather than part of the console.
 */
export function ConfirmAction({
  label,
  confirmLabel,
  prompt,
  disabled,
  onConfirm
}: {
  label: string;
  confirmLabel: string;
  prompt: string;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (armed) confirmRef.current?.focus();
  }, [armed]);

  if (!armed) {
    return (
      <button type="button" className="btn btn-danger btn-small" disabled={disabled} onClick={() => setArmed(true)}>
        {label}
      </button>
    );
  }
  return (
    <div className="confirm-bar">
      <p>{prompt}</p>
      <div className="actions">
        <button
          type="button"
          ref={confirmRef}
          className="btn btn-danger btn-small"
          disabled={disabled}
          onClick={() => {
            setArmed(false);
            onConfirm();
          }}
        >
          {confirmLabel}
        </button>
        <button type="button" className="btn btn-ghost btn-small" onClick={() => setArmed(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function StatusDot({ tone }: { tone: "live" | "active" | "warn" | "idle" }) {
  const modifier =
    tone === "live" ? " status-dot-live" : tone === "active" ? " status-dot-active" : tone === "warn" ? " status-dot-warn" : "";
  return <span className={`status-dot${modifier}`} aria-hidden="true" />;
}

export function PlaylistIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M2 3.5h9M2 7h9M2 10.5h5" strokeLinecap="square" />
      <circle cx="11.5" cy="11" r="2.2" />
      <path d="M13.7 11V5.5l1.8.7" strokeLinecap="square" />
    </svg>
  );
}

export function WatchIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="3.5" y="4.5" width="9" height="7" />
      <path d="M5.5 4.5V2.5h5v2M5.5 11.5v2h5v-2" strokeLinecap="square" />
    </svg>
  );
}

/**
 * Marks whether a block of the console can be changed here or only reports
 * state. The words carry the meaning; colour is a reinforcement, not the
 * signal, so this still reads correctly in monochrome.
 */
export function ModeTag({ mode }: { mode: "editable" | "readonly" }) {
  return mode === "editable" ? (
    <span className="tag tag-accent">Editable</span>
  ) : (
    <span className="tag">Read-only</span>
  );
}

/**
 * A value the operator has to retype somewhere else — currently the companion
 * origin, which goes into the watch's app settings by hand. Copying is the
 * point, so the value stays selectable even when the clipboard is unavailable
 * (a non-secure context, or a browser that withholds permission).
 */
export function CopyField({
  label,
  value,
  announce
}: {
  label: string;
  value: string | null;
  /** Reuses the app's single live region rather than opening a competing one. */
  announce: (message: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const valueRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy() {
    if (value === null) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      announce(`${label} copied to the clipboard.`);
    } catch {
      // Fall back to selecting it so the value can still be copied by hand.
      const node = valueRef.current;
      if (node !== null) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      announce(`${label} selected. Copy it with your keyboard.`);
    }
  }

  return (
    <div className="copy-field">
      <div className="copy-field-body">
        <p className="readout-label">{label}</p>
        <code className="copy-field-value mono" ref={valueRef}>
          {value ?? "…"}
        </code>
      </div>
      <button type="button" className="btn" onClick={() => void copy()} disabled={value === null}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
