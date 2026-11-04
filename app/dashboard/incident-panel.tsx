"use client";

import { useCallback, useEffect, useState } from "react";
import type { Incident, RecoveryAction, RecoveryActionType } from "@/lib/domain/types";
import { api, type EventRow, type IncidentDetail } from "./api";
import { button, Card, ConfidenceMeter, Drawer, humanize, Icon, money, Progress, Severity, Status, Tag, time, type Step } from "./ui";

const ACTION_LABEL: Record<RecoveryActionType, string> = {
  SYNC_LOCAL_STATUS: "Sync local status to PayPal",
  CREATE_LOCAL_RECORD: "Create the missing local record",
  REFUND_CAPTURE: "Refund the capture",
};

export function proposerLabel(proposedBy: string) {
  if (proposedBy === "system") return "Reconciliation";
  if (proposedBy.startsWith("ai:")) return "AI investigator";
  return proposedBy;
}

function progress(incident: Incident, actions: RecoveryAction[]): Step[] {
  const reached = [
    true,
    incident.aiAnalysis !== null,
    actions.some((a) => ["APPROVED", "EXECUTING", "EXECUTED"].includes(a.status)),
    actions.some((a) => a.status === "EXECUTED"),
    incident.status === "RESOLVED",
  ];
  const labels = ["Detected", "Investigated", "Approved", "Executed", "Resolved"];
  const firstOpen = reached.indexOf(false);
  return labels.map((label, i) => ({
    label,
    state: reached[i] ? "done" : i === firstOpen ? "current" : "todo",
    detail: i === 0 ? new Date(incident.detectedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : undefined,
  }));
}

const Eyebrow = ({ children }: { children: React.ReactNode }) => (
  <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-zinc-500">{children}</div>
);

export function EventTimeline({ events }: { events: EventRow[] }) {
  if (events.length === 0) {
    return <p className="text-[13px] text-zinc-500">No webhook events received for this order yet.</p>;
  }
  return (
    <ol className="space-y-0">
      {[...events]
        .sort((a, b) => a.firstReceivedAt.localeCompare(b.firstReceivedAt))
        .map((e, i, all) => (
          <li key={e.eventId} className="relative grid grid-cols-[12px_1fr] gap-3 pb-3">
            <span className="relative flex justify-center">
              <span className="mt-1.5 size-[7px] rounded-full bg-zinc-400 dark:bg-zinc-500" />
              {i < all.length - 1 && <span className="absolute top-4 h-[calc(100%-4px)] w-px bg-zinc-200 dark:bg-zinc-700" />}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-mono text-xs font-medium text-zinc-800 dark:text-zinc-200">{e.eventType}</span>
                <Status value={e.processingStatus} />
                {e.deliveryCount > 1 && <span className="text-xs text-zinc-500">{e.deliveryCount} deliveries</span>}
              </div>
              <div className="mt-0.5 text-xs text-zinc-500">
                {time(e.firstReceivedAt)}
                {e.processingError ? `. ${e.processingError}` : ""}
              </div>
            </div>
          </li>
        ))}
    </ol>
  );
}

export function IncidentPanel({
  id,
  actor,
  refreshCount,
  onClose,
  run,
}: {
  id: string;
  actor: string;
  refreshCount: number;
  onClose: () => void;
  run: (label: string, fn: () => Promise<unknown>, success?: string) => Promise<void>;
}) {
  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [investigating, setInvestigating] = useState(false);
  const [ack, setAck] = useState<Record<string, boolean>>({});

  const load = useCallback(() => api.incident(id).then(setDetail).catch(() => setDetail(null)), [id]);
  useEffect(() => {
    void load();
  }, [load, refreshCount]);

  if (!detail) {
    return (
      <Drawer title="Loading incident..." onClose={onClose}>
        <div className="h-32 animate-pulse rounded-lg bg-zinc-200/60 dark:bg-zinc-800/60" />
      </Drawer>
    );
  }

  const { incident, events, actions } = detail;
  const ai = incident.aiAnalysis;
  const needActor = !actor.trim();
  const inSync = incident.paypalStatus === incident.localStatus;

  const decide = (action: RecoveryAction, operation: "approve" | "reject" | "execute") =>
    run(
      `${operation}-${action.id}`,
      async () => {
        await api.decide(action.id, operation, {
          actor,
          acknowledgeFinancialImpact: operation === "approve" ? ack[action.id] : undefined,
        });
        await load();
      },
      operation === "execute" ? "Action executed after re-checking PayPal" : `Action ${operation}d`
    );

  const investigate = async () => {
    setInvestigating(true);
    await run("investigate", () => api.investigate(id), "AI investigation complete");
    await load();
    setInvestigating(false);
  };

  return (
    <Drawer
      title={incident.summary}
      eyebrow={
        <>
          <Severity value={incident.severity} />
          <Tag value={incident.status} />
          <span className="text-xs text-zinc-500">{humanize(incident.type)}</span>
        </>
      }
      onClose={onClose}
    >
      <Card>
        <Progress steps={progress(incident, actions)} />
      </Card>

      <section className="grid grid-cols-2 divide-x divide-zinc-200 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="p-4">
          <Eyebrow>PayPal, live</Eyebrow>
          <div className="mt-2 text-base font-semibold"><Status value={incident.paypalStatus} /></div>
          <div className="mt-1 text-xs text-zinc-500">Source of truth</div>
        </div>
        <div className={`p-4 ${inSync ? "" : "bg-red-50/60 dark:bg-red-500/5"}`}>
          <Eyebrow>Our record</Eyebrow>
          <div className="mt-2 text-base font-semibold">
            {incident.localStatus ? <Status value={incident.localStatus} /> : <span className="text-[13px] text-red-700">Missing</span>}
          </div>
          <div className={`mt-1 text-xs ${inSync ? "text-zinc-500" : "font-medium text-red-700 dark:text-red-400"}`}>
            {inSync ? "Matches PayPal" : "Out of sync with PayPal"}
          </div>
        </div>
      </section>

      <dl className="grid grid-cols-3 gap-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div>
          <dt><Eyebrow>At risk</Eyebrow></dt>
          <dd className="mt-1 text-[15px] font-semibold tabular-nums">{money(incident.financialImpact)}</dd>
        </div>
        <div className="min-w-0">
          <dt><Eyebrow>Order</Eyebrow></dt>
          <dd className="mt-1 truncate font-mono text-xs leading-6">{incident.orderId}</dd>
        </div>
        <div>
          <dt><Eyebrow>Detected</Eyebrow></dt>
          <dd className="mt-1 text-xs leading-6">{time(incident.detectedAt)}</dd>
        </div>
      </dl>

      <Card
        title="AI investigation"
        aside={
          <button disabled={investigating} onClick={investigate} className={button.ai}>
            <Icon name="sparkle" className="size-3.5" />
            {investigating ? "Investigating..." : ai ? "Run again" : "Investigate"}
          </button>
        }
      >
        {investigating && !ai && (
          <div className="space-y-2">
            <div className="h-2.5 w-3/4 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
            <div className="h-2.5 w-full animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
            <div className="h-2.5 w-2/3 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
            <p className="pt-1 text-xs text-zinc-500">Reading the PayPal order, our record and the webhook history.</p>
          </div>
        )}
        {!ai && !investigating && (
          <p className="text-[13px] leading-relaxed text-zinc-500">
            The investigator reads the live PayPal order, our record and every webhook for this order, then explains what
            happened and what it costs. It can propose fixes but never run them.
          </p>
        )}
        {ai && (
          <div className="space-y-4 text-[13px]">
            <div className="border-l-2 border-violet-500 pl-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Eyebrow>Root cause</Eyebrow>
                <ConfidenceMeter level={ai.confidence} />
              </div>
              <p className="mt-1 text-[15px] font-medium leading-snug text-zinc-900 dark:text-zinc-100">{ai.rootCause}</p>
            </div>
            <p className="whitespace-pre-line leading-relaxed text-zinc-700 dark:text-zinc-300">{ai.explanation}</p>

            <div className="grid divide-y divide-zinc-200 rounded-md border border-zinc-200 sm:grid-cols-2 sm:divide-x sm:divide-y-0 dark:divide-zinc-800 dark:border-zinc-800">
              <div className="p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <Eyebrow>Financial impact</Eyebrow>
                  {ai.financialImpact.amountAtRisk && (
                    <span className="text-[13px] font-semibold tabular-nums text-red-700 dark:text-red-400">
                      {ai.financialImpact.currency} {ai.financialImpact.amountAtRisk}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">{ai.financialImpact.summary}</p>
              </div>
              <div className="p-3">
                <Eyebrow>Customer impact</Eyebrow>
                <p className="mt-1 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">{ai.customerImpact}</p>
              </div>
            </div>

            {ai.recommendedActions.length > 0 && (
              <div>
                <Eyebrow>Recommended</Eyebrow>
                <ul className="mt-2 divide-y divide-zinc-100 dark:divide-zinc-800">
                  {ai.recommendedActions.map((r, i) => (
                    <li key={i} className="flex items-start gap-3 py-2 first:pt-0">
                      <span className="mt-px w-24 shrink-0 whitespace-nowrap text-xs font-medium text-zinc-500">{humanize(r.risk)} risk</span>
                      <span className="leading-relaxed">
                        <span className="font-medium text-zinc-900 dark:text-zinc-100">
                          {r.type in ACTION_LABEL ? ACTION_LABEL[r.type as RecoveryActionType] : humanize(r.type)}.
                        </span>{" "}
                        <span className="text-zinc-600 dark:text-zinc-400">{r.description}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 flex items-center gap-1.5 text-xs text-zinc-500">
                  <Icon name="shield" className="size-3.5" /> Filed as proposals below. Nothing runs until a person approves it.
                </p>
              </div>
            )}

            {ai.evidenceAssessment.length > 0 && (
              <details>
                <summary className="cursor-pointer text-xs font-medium text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
                  Evidence used ({ai.evidenceAssessment.length})
                </summary>
                <ul className="mt-2 space-y-1.5 text-xs">
                  {ai.evidenceAssessment.map((e, i) => (
                    <li key={i} className="leading-relaxed">
                      <span className="font-mono text-zinc-500">{e.reference}</span> {e.interpretation}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <p className="font-mono text-[11px] text-zinc-400">
              {ai.model} / {time(ai.generatedAt)}
            </p>
          </div>
        )}
      </Card>

      <Card
        title="Recovery actions"
        aside={needActor && <span className="text-xs text-amber-700 dark:text-amber-400">Enter your name in &quot;Acting as&quot; to decide</span>}
      >
        {actions.length === 0 && <p className="text-[13px] text-zinc-500">No actions proposed.</p>}
        <ul className="space-y-3">
          {actions.map((a) => (
            <li
              key={a.id}
              className={`rounded-md border text-[13px] ${a.financial ? "border-red-200 dark:border-red-900/60" : "border-zinc-200 dark:border-zinc-800"}`}
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 pt-3">
                <span className="font-semibold text-zinc-900 dark:text-zinc-100">{ACTION_LABEL[a.type]}</span>
                <Tag value={a.status} />
                {a.financial && <Tag tone="red">Moves money</Tag>}
                {a.params.amount && <span className="text-xs font-medium tabular-nums">{money(a.params.amount)}</span>}
                <span className="ml-auto text-xs text-zinc-500">Proposed by {proposerLabel(a.proposedBy)}</span>
              </div>
              <p className="px-3 pt-1.5 leading-relaxed text-zinc-600 dark:text-zinc-400">{a.rationale}</p>

              {a.status === "PROPOSED" && (
                <div className="flex flex-wrap items-center gap-2 px-3 pt-3">
                  {a.financial && (
                    <label className="mr-1 flex items-center gap-1.5 text-xs font-medium text-red-800 dark:text-red-300">
                      <input
                        type="checkbox"
                        checked={!!ack[a.id]}
                        onChange={(e) => setAck({ ...ack, [a.id]: e.target.checked })}
                        className="accent-red-700"
                      />
                      I understand this moves real money
                    </label>
                  )}
                  <button disabled={needActor || (a.financial && !ack[a.id])} onClick={() => decide(a, "approve")} className={button.approve}>
                    Approve
                  </button>
                  <button disabled={needActor} onClick={() => decide(a, "reject")} className={button.secondary}>
                    Reject
                  </button>
                </div>
              )}
              {a.status === "APPROVED" && (
                <div className="flex flex-wrap items-center gap-3 px-3 pt-3">
                  <button disabled={needActor} onClick={() => decide(a, "execute")} className={button.primary}>
                    Execute
                  </button>
                  <span className="text-xs text-zinc-500">PayPal is checked again right before this runs.</span>
                </div>
              )}
              {a.status === "UNCERTAIN" && (
                <div className="mx-3 mt-3 rounded-md bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
                  <p className="leading-relaxed">
                    PayPal didn&apos;t give a definite answer, so this refund may or may not have happened. Retrying first looks for it at
                    PayPal, then resends with the <span className="font-semibold">same</span> PayPal-Request-Id, so it can&apos;t be refunded twice.
                  </p>
                  <button disabled={needActor} onClick={() => decide(a, "execute")} className={`${button.primary} mt-2`}>
                    Check PayPal and retry
                  </button>
                </div>
              )}
              {a.refundOperation && (
                <dl className="mx-3 mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px] text-zinc-500">
                  <dt>PayPal-Request-Id</dt>
                  <dd className="truncate">{a.refundOperation.requestId}</dd>
                  <dt>invoice_id</dt>
                  <dd className="truncate">{a.refundOperation.invoiceId}</dd>
                  <dt>attempts</dt>
                  <dd>{a.refundOperation.attempts}</dd>
                  {a.refundOperation.refundId && (
                    <>
                      <dt>refund</dt>
                      <dd className="truncate">
                        {a.refundOperation.refundId} ({a.refundOperation.refundStatus})
                      </dd>
                    </>
                  )}
                </dl>
              )}

              <table className="mt-3 w-full border-t border-zinc-100 text-xs dark:border-zinc-800">
                <tbody>
                  {a.audit.map((entry, i) => (
                    <tr key={i} className="align-top text-zinc-500">
                      <td className="w-24 py-1 pl-3 font-medium text-zinc-700 dark:text-zinc-300">{humanize(entry.event)}</td>
                      <td className="w-32 py-1">{proposerLabel(entry.actor)}</td>
                      <td className="py-1 pr-3">
                        {time(entry.at)}
                        {entry.detail && entry.event !== "PROPOSED" && <div className="text-zinc-400">{entry.detail}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Evidence">
        <ul className="divide-y divide-zinc-100 text-xs dark:divide-zinc-800">
          {incident.evidence.map((e, i) => (
            <li key={i} className="grid grid-cols-[84px_1fr] gap-3 py-2 first:pt-0">
              <span className="font-medium text-zinc-500">{e.source === "paypal_api" ? "PayPal API" : e.source === "local_db" ? "Our record" : "Webhook"}</span>
              <span className="min-w-0 leading-relaxed text-zinc-700 dark:text-zinc-300">
                {e.detail}
                <span className="block truncate font-mono text-[11px] text-zinc-400">{e.reference}</span>
              </span>
            </li>
          ))}
        </ul>
        <h3 className="mb-3 mt-5"><Eyebrow>Webhook timeline</Eyebrow></h3>
        <EventTimeline events={events} />
      </Card>
    </Drawer>
  );
}
