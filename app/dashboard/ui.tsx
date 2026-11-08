"use client";

import { useEffect, type ReactNode } from "react";
import type { Money } from "@/lib/domain/types";

export const money = (m: Money | null | undefined) => (m ? `${m.currency} ${m.value}` : "-");
export const time = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "-");
// compact form for grid cells, e.g. "Nov 3, 01:38"
export const shortTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "-";

// "SYNC_LOCAL_STATUS" -> "Sync local status"
export const humanize = (value: string) => value.charAt(0) + value.slice(1).toLowerCase().replaceAll("_", " ");

const LABELS: Record<string, string> = {
  SIMULATED_VERIFIED: "Simulated",
  "IN SYNC": "In sync",
  "NOT CHECKED": "Not checked",
  UNCERTAIN: "Outcome unknown",
};
const label = (value: string) => LABELS[value] ?? humanize(value);

export const button = {
  primary:
    "inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white",
  secondary:
    "inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-[13px] font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800",
  ai: "inline-flex items-center gap-1.5 rounded-md border border-violet-300 bg-violet-50 px-3 py-1.5 text-[13px] font-medium text-violet-800 transition-colors hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-violet-800 dark:bg-violet-950/50 dark:text-violet-200 dark:hover:bg-violet-900/50",
  approve:
    "inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-40",
};

export const input =
  "rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-[13px] outline-none transition-colors placeholder:text-zinc-400 focus:border-zinc-500 focus:ring-2 focus:ring-zinc-900/10 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-zinc-500 dark:focus:ring-white/10";

type Tone = "red" | "orange" | "amber" | "green" | "blue" | "violet" | "gray" | "ink";

const TAG_TONE: Record<Tone, string> = {
  red: "bg-red-100/80 text-red-800 dark:bg-red-500/15 dark:text-red-300",
  orange: "bg-orange-100/80 text-orange-800 dark:bg-orange-500/15 dark:text-orange-300",
  amber: "bg-amber-100/80 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300",
  green: "bg-emerald-100/80 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
  blue: "bg-sky-100/80 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300",
  violet: "bg-violet-100/80 text-violet-800 dark:bg-violet-500/15 dark:text-violet-300",
  gray: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  ink: "bg-white text-zinc-800 shadow-[inset_0_0_0_1px_rgb(212_212_216)] dark:bg-transparent dark:text-zinc-200 dark:shadow-[inset_0_0_0_1px_rgb(82_82_91)]",
};

const SQUARE_TONE: Record<Tone, string> = {
  red: "bg-red-500",
  orange: "bg-orange-500",
  amber: "bg-amber-500",
  green: "bg-emerald-500",
  blue: "bg-sky-500",
  violet: "bg-violet-500",
  gray: "bg-zinc-400 dark:bg-zinc-500",
  ink: "bg-zinc-900 dark:bg-zinc-100",
};

const TONE_OF: Record<string, Tone> = {
  OPEN: "ink",
  RESOLVED: "green",
  PROPOSED: "blue",
  APPROVED: "violet",
  EXECUTING: "violet",
  EXECUTED: "green",
  REJECTED: "gray",
  FAILED: "red",
  UNCERTAIN: "amber",
  PROCESSED: "green",
  CONFIRMED: "green",
  IGNORED: "gray",
  VERIFIED: "green",
  SIMULATED_VERIFIED: "amber",
  COMPLETED: "green",
  PENDING: "amber",
  CREATED: "gray",
  DECLINED: "red",
  REFUNDED: "violet",
  PARTIALLY_REFUNDED: "violet",
  REVERSED: "red",
  VOIDED: "gray",
  UNKNOWN: "gray",
};

// Flat label for workflow states: Open, Proposed, Executed...
export function Tag({ value, tone, children }: { value?: string | null; tone?: Tone; children?: ReactNode }) {
  if (!value && !children) return <span className="text-zinc-400">-</span>;
  const t = tone ?? (value ? TONE_OF[value] : undefined) ?? "gray";
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-[3px] px-1.5 py-px text-xs font-medium leading-5 ${TAG_TONE[t]}`}>
      {children ?? label(value!)}
    </span>
  );
}

// Payment/processing state: small square plus plain text, quieter than a tag.
export function Status({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-zinc-400">-</span>;
  const t = TONE_OF[value] ?? "gray";
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] text-zinc-700 dark:text-zinc-300">
      <span className={`size-[7px] rounded-[1.5px] ${SQUARE_TONE[t]}`} />
      {label(value)}
    </span>
  );
}

const SEVERITY: Record<string, { bars: number; color: string; text: string }> = {
  CRITICAL: { bars: 4, color: "bg-red-600 dark:bg-red-500", text: "text-red-700 dark:text-red-400" },
  HIGH: { bars: 3, color: "bg-orange-500", text: "text-orange-700 dark:text-orange-400" },
  MEDIUM: { bars: 2, color: "bg-amber-500", text: "text-zinc-700 dark:text-zinc-300" },
  LOW: { bars: 1, color: "bg-zinc-500", text: "text-zinc-600 dark:text-zinc-400" },
};

export function Severity({ value }: { value: string | null | undefined }) {
  const s = value ? SEVERITY[value] : undefined;
  if (!value || !s) return <span className="text-zinc-400">-</span>;
  return (
    <span className={`inline-flex items-center gap-2 text-[13px] font-medium ${s.text}`} title={`${label(value)} severity`}>
      <span className="flex h-3.5 items-end gap-[2px]" aria-hidden="true">
        {[1, 2, 3, 4].map((n) => (
          <span key={n} className={`w-[3px] rounded-[1px] ${n <= s.bars ? s.color : "bg-zinc-200 dark:bg-zinc-700"}`} style={{ height: `${n * 25}%` }} />
        ))}
      </span>
      {label(value)}
    </span>
  );
}

export function Reconciliation({ value }: { value: string | null | undefined }) {
  if (value === "IN SYNC") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-emerald-700 dark:text-emerald-400">
        <Icon name="check" className="size-3.5" /> In sync
      </span>
    );
  }
  if (value === "MISMATCH") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-red-700 dark:text-red-400">
        <Icon name="notEqual" className="size-3.5" /> Mismatch
      </span>
    );
  }
  return <span className="text-[13px] text-zinc-400">Not checked</span>;
}

export function Kpi({
  label: title,
  value,
  sub,
  alert,
  onClick,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  alert?: boolean;
  onClick?: () => void;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between text-[13px] text-zinc-500">
        {title}
        {alert && <span className="size-1.5 rounded-full bg-red-500" />}
      </div>
      <div className={`mt-2 text-[26px] font-semibold leading-none tabular-nums tracking-tight ${alert ? "text-red-600 dark:text-red-400" : ""}`}>
        {value}
      </div>
      {sub && <div className="mt-2 text-xs text-zinc-500">{sub}</div>}
    </>
  );
  const cls = "flex flex-col justify-start rounded-lg border border-zinc-200 bg-white px-4 py-3.5 text-left dark:border-zinc-800 dark:bg-zinc-900";
  return onClick ? (
    <button onClick={onClick} className={`${cls} transition-colors hover:border-zinc-400 dark:hover:border-zinc-600`}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function Card({ title, aside, children, className = "" }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900 ${className}`}>
      {(title || aside) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export function Drawer({
  title,
  eyebrow,
  onClose,
  children,
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="animate-fade-in fixed inset-0 z-50 flex justify-end bg-zinc-950/30" onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        className="animate-slide-in flex h-full w-full max-w-2xl flex-col border-l border-zinc-200 bg-zinc-50 shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-zinc-200 bg-white px-5 py-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="min-w-0">
            {eyebrow && <div className="mb-1.5 flex flex-wrap items-center gap-2.5">{eyebrow}</div>}
            <h2 className="text-[15px] font-semibold leading-snug">{title}</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            <Icon name="close" />
          </button>
        </header>
        <div className="flex-1 space-y-4 overflow-y-auto p-5">{children}</div>
      </aside>
    </div>
  );
}

export interface Notice {
  kind: "ok" | "error";
  text: string;
}

export function Toast({ notice, onClose }: { notice: Notice | null; onClose: () => void }) {
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(onClose, notice.kind === "ok" ? 5000 : 9000);
    return () => clearTimeout(timer);
  }, [notice, onClose]);

  if (!notice) return null;
  const ok = notice.kind === "ok";
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-[60] flex justify-center px-4 sm:justify-end sm:px-6">
      <div
        role="status"
        className="animate-slide-in pointer-events-auto flex max-w-md items-start gap-3 rounded-md border border-zinc-200 bg-white py-2.5 pl-3 pr-2.5 text-[13px] text-zinc-800 shadow-lg dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
      >
        <span className={`mt-0.5 w-[3px] self-stretch rounded-full ${ok ? "bg-emerald-500" : "bg-red-500"}`} />
        <span className="flex-1 leading-relaxed">{notice.text}</span>
        <button onClick={onClose} aria-label="Dismiss" className="mt-0.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
          <Icon name="close" className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

export interface Step {
  label: string;
  detail?: string;
  state: "done" | "current" | "todo";
}

// thin segmented progress bar, one segment per lifecycle step
export function Progress({ steps }: { steps: Step[] }) {
  return (
    <ol className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
      {steps.map((step) => (
        <li key={step.label}>
          <div
            className={`h-1 rounded-full ${
              step.state === "done"
                ? "bg-emerald-600"
                : step.state === "current"
                  ? "bg-zinc-900 dark:bg-zinc-100"
                  : "bg-zinc-200 dark:bg-zinc-800"
            }`}
          />
          <div
            className={`mt-2 text-xs ${
              step.state === "todo"
                ? "text-zinc-400"
                : step.state === "current"
                  ? "font-semibold text-zinc-900 dark:text-zinc-100"
                  : "font-medium text-zinc-600 dark:text-zinc-300"
            }`}
          >
            {step.label}
          </div>
          {step.detail && <div className="text-[11px] text-zinc-400">{step.detail}</div>}
        </li>
      ))}
    </ol>
  );
}

export function ConfidenceMeter({ level }: { level: "LOW" | "MEDIUM" | "HIGH" }) {
  const filled = { LOW: 1, MEDIUM: 2, HIGH: 3 }[level];
  return (
    <span className="inline-flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-300" title={`${label(level)} confidence`}>
      <span className="flex h-3 items-end gap-[2px]" aria-hidden="true">
        {[1, 2, 3].map((n) => (
          <span key={n} className={`w-[3px] rounded-[1px] ${n <= filled ? "bg-violet-600 dark:bg-violet-400" : "bg-zinc-200 dark:bg-zinc-700"}`} style={{ height: `${(n / 3) * 100}%` }} />
        ))}
      </span>
      {label(level)} confidence
    </span>
  );
}

const PATHS = {
  close: <path d="M6 6l12 12M18 6L6 18" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  notEqual: <path d="M5 9.5h14M5 14.5h14M15.5 5l-7 14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4-4" />
    </>
  ),
  sparkle: <path d="M12 4v4M12 16v4M4 12h4M16 12h4M7 7l2 2M15 15l2 2M17 7l-2 2M9 15l-2 2" />,
  refresh: <path d="M20 11a8 8 0 0 0-14.6-4.5M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5M20 20v-4h-4" />,
  shield: <path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z" />,
  arrow: <path d="M9 6l6 6-6 6" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
  monitor: (
    <>
      <rect x="3" y="4.5" width="18" height="12" rx="1.5" />
      <path d="M9 20h6M12 16.5V20" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type ThemePreference = "light" | "dark" | "system";

export function ThemeToggle({ value, onChange }: { value: ThemePreference; onChange: (value: ThemePreference) => void }) {
  const options: [ThemePreference, "sun" | "moon" | "monitor", string][] = [
    ["light", "sun", "Light"],
    ["dark", "moon", "Dark"],
    ["system", "monitor", "Match system"],
  ];
  return (
    <div className="flex rounded-md border border-zinc-300 p-0.5 dark:border-zinc-700" role="radiogroup" aria-label="Theme">
      {options.map(([key, icon, title]) => (
        <button
          key={key}
          role="radio"
          aria-checked={value === key}
          title={title}
          onClick={() => onChange(key)}
          className={`rounded-[4px] p-1 transition-colors ${
            value === key ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
          }`}
        >
          <Icon name={icon} className="size-3.5" />
        </button>
      ))}
    </div>
  );
}

export function Icon({ name, className = "size-4" }: { name: keyof typeof PATHS; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

export function Logo() {
  return (
    <svg viewBox="0 0 28 28" className="size-7" aria-hidden="true">
      <rect width="28" height="28" rx="6" className="fill-zinc-900 dark:fill-zinc-100" />
      <path d="M6 16h4l2.5-6 3.5 10 2.5-6H22" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="stroke-white dark:stroke-zinc-900" />
    </svg>
  );
}
