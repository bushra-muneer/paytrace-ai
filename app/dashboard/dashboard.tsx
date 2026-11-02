"use client";

import {
  AllCommunityModule,
  colorSchemeDark,
  colorSchemeLight,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
  type RowClickedEvent,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Incident, Money, RecoveryAction, Transaction } from "@/lib/domain/types";
import { api, type EventRow, type IncidentDetail } from "./api";

ModuleRegistry.registerModules([AllCommunityModule]);

type Tab = "incidents" | "transactions" | "events" | "actions";

const TONE: Record<string, string> = {
  CRITICAL: "bg-red-600 text-white",
  HIGH: "bg-orange-500 text-white",
  MEDIUM: "bg-amber-300 text-amber-950",
  LOW: "bg-zinc-300 text-zinc-900",
  OPEN: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
  RESOLVED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  PROPOSED: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
  APPROVED: "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200",
  EXECUTED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  REJECTED: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  FAILED: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
  PROCESSED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  IGNORED: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  "IN SYNC": "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  MISMATCH: "bg-red-600 text-white",
  "NOT CHECKED": "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  "NOT RUN": "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
};

function Badge({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-zinc-400">-</span>;
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${TONE[value] ?? "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200"}`}>
      {value}
    </span>
  );
}

const badgeCell = (p: { value?: string | null }) => <Badge value={p.value} />;
const money = (m: Money | null | undefined) => (m ? `${m.currency} ${m.value}` : "-");
const time = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "-");

const SEVERITY_RANK: Record<string, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

// sort/filter money as a number, show it with its currency
function moneyColumn<T>(headerName: string, get: (row: T) => Money | null | undefined): ColDef<T> {
  return {
    headerName,
    valueGetter: (p) => {
      const m = p.data ? get(p.data) : null;
      return m ? Number(m.value) : null;
    },
    valueFormatter: (p) => money(p.data ? get(p.data) : null),
    filter: "agNumberColumnFilter",
    type: "rightAligned",
    width: 130,
  };
}

function reconciliationState(tx: Transaction): string {
  if (!tx.lastReconciledAt || !tx.paypalStatus) return "NOT CHECKED";
  return tx.paypalStatus === tx.localStatus ? "IN SYNC" : "MISMATCH";
}

function usePrefersDark() {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
    () => false
  );
}

function useActorName(): [string, (name: string) => void] {
  const [actor, setActor] = useState("");
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time restore from storage
      setActor(localStorage.getItem("paytrace.actor") ?? "");
    } catch {
      /* storage unavailable */
    }
  }, []);
  const update = (name: string) => {
    setActor(name);
    try {
      localStorage.setItem("paytrace.actor", name);
    } catch {
      /* storage unavailable */
    }
  };
  return [actor, update];
}

export default function Dashboard() {
  const dark = usePrefersDark();
  const theme = useMemo(() => themeQuartz.withPart(dark ? colorSchemeDark : colorSchemeLight), [dark]);

  const [tab, setTab] = useState<Tab>("incidents");
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [actions, setActions] = useState<RecoveryAction[]>([]);
  const [selectedIncident, setSelectedIncident] = useState<string | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [actor, setActor] = useActorName();
  const [newOrder, setNewOrder] = useState({ amount: "10.00", currency: "EUR" });
  const [approveUrl, setApproveUrl] = useState<string | null>(null);
  const [refreshCount, setRefreshCount] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const [t, e, i, a] = await Promise.all([api.transactions(), api.events(), api.incidents(), api.actions()]);
      setTransactions(t);
      setEvents(e);
      setIncidents(i);
      setActions(a);
      setRefreshCount((n) => n + 1);
    } catch (error) {
      setNotice({ kind: "error", text: `Refresh failed: ${(error as Error).message}` });
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data load
    void refresh();
    const timer = setInterval(refresh, 15000);
    return () => clearInterval(timer);
  }, [refresh]);

  const run = useCallback(
    async (label: string, fn: () => Promise<unknown>, success?: string) => {
      setBusy(label);
      setNotice(null);
      try {
        await fn();
        if (success) setNotice({ kind: "ok", text: success });
      } catch (error) {
        setNotice({ kind: "error", text: (error as Error).message });
      } finally {
        setBusy(null);
        await refresh();
      }
    },
    [refresh]
  );

  const openIncidents = incidents.filter((i) => i.status === "OPEN");
  const atRisk = Object.entries(
    openIncidents.reduce<Record<string, number>>((acc, i) => {
      if (i.financialImpact) {
        acc[i.financialImpact.currency] = (acc[i.financialImpact.currency] ?? 0) + Number(i.financialImpact.value);
      }
      return acc;
    }, {})
  );

  const awaitingApproval = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of actions) if (a.status === "PROPOSED") counts[a.incidentId] = (counts[a.incidentId] ?? 0) + 1;
    return counts;
  }, [actions]);

  // open first, then worst first, then most recent
  const incidentCols = useMemo<ColDef<Incident>[]>(
    () => [
      { field: "status", cellRenderer: badgeCell, width: 110, sort: "asc", sortIndex: 0 },
      {
        field: "severity",
        cellRenderer: badgeCell,
        width: 120,
        comparator: (a: string, b: string) => (SEVERITY_RANK[a] ?? 0) - (SEVERITY_RANK[b] ?? 0),
        sort: "desc",
        sortIndex: 1,
      },
      { field: "type", width: 190 },
      { field: "summary", flex: 2, minWidth: 240 },
      { field: "paypalStatus", headerName: "PayPal", cellRenderer: badgeCell, width: 130 },
      { field: "localStatus", headerName: "Local", cellRenderer: badgeCell, width: 130 },
      moneyColumn<Incident>("At risk", (i) => i.financialImpact),
      {
        headerName: "AI analysis",
        valueGetter: (p) => (p.data?.aiAnalysis ? `${p.data.aiAnalysis.confidence} CONFIDENCE` : "NOT RUN"),
        cellRenderer: badgeCell,
        width: 160,
      },
      {
        headerName: "Awaiting approval",
        valueGetter: (p) => (p.data ? awaitingApproval[p.data.id] ?? 0 : 0),
        filter: "agNumberColumnFilter",
        width: 150,
      },
      { field: "orderId", width: 190 },
      { field: "lastSeenAt", headerName: "Last seen", valueFormatter: (p) => time(p.value), width: 180, sort: "desc", sortIndex: 2 },
    ],
    [awaitingApproval]
  );

  const transactionCols = useMemo<ColDef<Transaction>[]>(
    () => [
      { headerName: "Reconciliation", valueGetter: (p) => (p.data ? reconciliationState(p.data) : null), cellRenderer: badgeCell, width: 150 },
      { field: "orderId", width: 190 },
      { field: "localStatus", headerName: "Local", cellRenderer: badgeCell, width: 150 },
      { field: "paypalStatus", headerName: "PayPal (last seen)", cellRenderer: badgeCell, width: 160 },
      moneyColumn<Transaction>("Amount", (t) => t.amount),
      { field: "captureId", width: 190 },
      { field: "lastUpdatedBy", headerName: "Updated by", width: 120 },
      { field: "lastReconciledAt", headerName: "Reconciled", valueFormatter: (p) => time(p.value), width: 180 },
      { field: "updatedAt", headerName: "Updated", valueFormatter: (p) => time(p.value), flex: 1, sort: "desc" },
    ],
    []
  );

  const eventCols = useMemo<ColDef<EventRow>[]>(
    () => [
      { field: "eventType", width: 240 },
      { field: "processingStatus", headerName: "Processing", cellRenderer: badgeCell, width: 130 },
      { field: "orderId", width: 190 },
      { field: "captureId", width: 190 },
      { field: "resourceStatus", headerName: "Resource status", width: 140 },
      moneyColumn<EventRow>("Amount", (e) => e.amount),
      { field: "deliveryCount", headerName: "Deliveries", filter: "agNumberColumnFilter", width: 120 },
      { field: "verification", width: 170 },
      { field: "processingError", headerName: "Note", flex: 1, minWidth: 200 },
      { field: "lastReceivedAt", headerName: "Received", valueFormatter: (p) => time(p.value), width: 180, sort: "desc" },
    ],
    []
  );

  const actionCols = useMemo<ColDef<RecoveryAction>[]>(
    () => [
      { field: "status", cellRenderer: badgeCell, width: 120 },
      { field: "type", width: 200 },
      { field: "financial", headerName: "Moves money", valueFormatter: (p) => (p.value ? "Yes" : ""), width: 120 },
      { field: "orderId", width: 190 },
      { field: "rationale", flex: 2, minWidth: 260 },
      { field: "proposedBy", width: 170 },
      { field: "decidedBy", width: 130 },
      { field: "proposedAt", headerName: "Proposed", valueFormatter: (p) => time(p.value), width: 180, sort: "desc" },
    ],
    []
  );

  const defaultColDef = useMemo<ColDef>(() => ({ sortable: true, filter: true, resizable: true }), []);

  const grid = (() => {
    switch (tab) {
      case "incidents":
        return (
          <AgGridReact<Incident>
            theme={theme}
            rowData={incidents}
            columnDefs={incidentCols}
            defaultColDef={defaultColDef}
            getRowId={(p) => p.data.id}
            onRowClicked={(e: RowClickedEvent<Incident>) => e.data && setSelectedIncident(e.data.id)}
          />
        );
      case "transactions":
        return (
          <AgGridReact<Transaction>
            theme={theme}
            rowData={transactions}
            columnDefs={transactionCols}
            defaultColDef={defaultColDef}
            getRowId={(p) => p.data.orderId}
            onRowClicked={(e: RowClickedEvent<Transaction>) => e.data && setSelectedOrder(e.data.orderId)}
          />
        );
      case "events":
        return (
          <AgGridReact<EventRow>
            theme={theme}
            rowData={events}
            columnDefs={eventCols}
            defaultColDef={defaultColDef}
            getRowId={(p) => p.data.eventId}
          />
        );
      case "actions":
        return (
          <AgGridReact<RecoveryAction>
            theme={theme}
            rowData={actions}
            columnDefs={actionCols}
            defaultColDef={defaultColDef}
            getRowId={(p) => p.data.id}
            onRowClicked={(e: RowClickedEvent<RecoveryAction>) => e.data && setSelectedIncident(e.data.incidentId)}
          />
        );
    }
  })();

  const selectedTx = transactions.find((t) => t.orderId === selectedOrder) ?? null;

  return (
    <div className="flex min-h-screen flex-col gap-4 bg-zinc-50 p-4 text-zinc-900 sm:p-6 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">PayTrace AI</h1>
          <p className="text-sm text-zinc-500">Payment observability and recovery | PayPal Sandbox</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label className="flex items-center gap-1">
            <span className="text-zinc-500">Acting as</span>
            <input
              value={actor}
              onChange={(e) => setActor(e.target.value)}
              placeholder="your name"
              className="w-32 rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <button
            onClick={() =>
              run("reconcile", async () => {
                const r = await api.reconcileAll();
                const failed = r.errors.length ? `, ${r.errors.length} could not be checked` : "";
                setNotice({ kind: r.errors.length ? "error" : "ok", text: `Checked ${r.reconciled} orders against PayPal: ${r.inSync} in sync${failed}` });
              })
            }
            disabled={busy !== null}
            className="rounded bg-zinc-900 px-3 py-1.5 font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {busy === "reconcile" ? "Reconciling..." : "Reconcile all"}
          </button>
          <button onClick={() => void refresh()} className="rounded border border-zinc-300 px-3 py-1.5 dark:border-zinc-700">
            Refresh
          </button>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Kpi label="Open incidents" value={openIncidents.length} alert={openIncidents.length > 0} />
        <Kpi
          label="Money at risk"
          value={atRisk.length ? atRisk.map(([c, v]) => `${c} ${v.toFixed(2)}`).join(" | ") : "-"}
          alert={atRisk.length > 0}
        />
        <Kpi label="Awaiting approval" value={actions.filter((a) => a.status === "PROPOSED").length} />
        <Kpi label="Transactions" value={transactions.length} />
        <Kpi
          label="Webhook events"
          value={events.length}
          sub={`${events.filter((e) => e.processingStatus === "FAILED").length} failed`}
        />
      </section>

      <section className="flex flex-wrap items-center gap-2 rounded border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900">
        <span className="font-medium">New sandbox order</span>
        <input
          value={newOrder.amount}
          onChange={(e) => setNewOrder({ ...newOrder, amount: e.target.value })}
          className="w-20 rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
        />
        <input
          value={newOrder.currency}
          onChange={(e) => setNewOrder({ ...newOrder, currency: e.target.value })}
          className="w-16 rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
        />
        <button
          disabled={busy !== null}
          onClick={() =>
            run("create", async () => {
              const r = await api.createOrder(newOrder.amount, newOrder.currency);
              setApproveUrl(r.approveUrl);
              setNotice({ kind: "ok", text: `Created order ${r.orderId}. Approve it as the sandbox buyer, then capture it from the Transactions tab.` });
            })
          }
          className="rounded border border-zinc-300 px-3 py-1 disabled:opacity-50 dark:border-zinc-700"
        >
          Create
        </button>
        {approveUrl && (
          <a href={approveUrl} target="_blank" rel="noopener noreferrer" className="text-sky-600 underline">
            Open PayPal approval page
          </a>
        )}
      </section>

      {notice && (
        <div
          role="status"
          className={`rounded px-3 py-2 text-sm ${notice.kind === "ok" ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200" : "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200"}`}
        >
          {notice.text}
        </div>
      )}

      <nav className="flex gap-1 border-b border-zinc-200 text-sm dark:border-zinc-800">
        {(
          [
            ["incidents", `Incidents (${openIncidents.length} open)`],
            ["transactions", `Transactions (${transactions.length})`],
            ["events", `Webhook events (${events.length})`],
            ["actions", `Recovery actions (${actions.length})`],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-3 py-2 ${tab === key ? "border-zinc-900 font-medium dark:border-zinc-100" : "border-transparent text-zinc-500"}`}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="h-[560px] min-h-0">{grid}</div>

      {selectedIncident && (
        <IncidentPanel
          id={selectedIncident}
          actor={actor}
          refreshCount={refreshCount}
          onClose={() => setSelectedIncident(null)}
          run={run}
        />
      )}

      {selectedTx && (
        <Drawer title={`Order ${selectedTx.orderId}`} onClose={() => setSelectedOrder(null)}>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-zinc-500">Local status</dt>
            <dd><Badge value={selectedTx.localStatus} /></dd>
            <dt className="text-zinc-500">PayPal (last seen)</dt>
            <dd><Badge value={selectedTx.paypalStatus} /></dd>
            <dt className="text-zinc-500">Amount</dt>
            <dd>{money(selectedTx.amount)}</dd>
            <dt className="text-zinc-500">Capture</dt>
            <dd className="font-mono text-xs">{selectedTx.captureId ?? "-"}</dd>
          </dl>
          <div className="mt-4 flex gap-2 text-sm">
            <button
              disabled={busy !== null}
              onClick={() => run("reconcile-one", () => api.reconcile(selectedTx.orderId), "Order reconciled")}
              className="rounded bg-zinc-900 px-3 py-1.5 text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
            >
              Reconcile
            </button>
            {(selectedTx.localStatus === "APPROVED" || selectedTx.localStatus === "CREATED") && (
              <button
                disabled={busy !== null}
                onClick={() => run("capture", () => api.captureOrder(selectedTx.orderId), "Capture submitted")}
                className="rounded border border-zinc-300 px-3 py-1.5 disabled:opacity-50 dark:border-zinc-700"
              >
                Capture payment
              </button>
            )}
          </div>
          <h3 className="mt-6 mb-2 text-sm font-medium">Webhook events</h3>
          <EventTimeline events={events.filter((e) => e.orderId === selectedTx.orderId)} />
        </Drawer>
      )}
    </div>
  );
}

function Kpi({ label, value, sub, alert }: { label: string; value: string | number; sub?: string; alert?: boolean }) {
  return (
    <div className="rounded border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${alert ? "text-red-600 dark:text-red-400" : ""}`}>{value}</div>
      {sub && <div className="text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}

function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <aside
        className="h-full w-full max-w-xl overflow-y-auto bg-white p-5 shadow-xl dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-2">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
            x
          </button>
        </div>
        {children}
      </aside>
    </div>
  );
}

function EventTimeline({ events }: { events: EventRow[] }) {
  if (events.length === 0) return <p className="text-sm text-zinc-500">No webhook events received for this order.</p>;
  return (
    <ol className="space-y-2 border-l border-zinc-200 pl-4 text-sm dark:border-zinc-700">
      {[...events]
        .sort((a, b) => a.firstReceivedAt.localeCompare(b.firstReceivedAt))
        .map((e) => (
          <li key={e.eventId}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">{e.eventType}</span>
              <Badge value={e.processingStatus} />
              {e.deliveryCount > 1 && <span className="text-xs text-zinc-500">x{e.deliveryCount}</span>}
            </div>
            <div className="text-xs text-zinc-500">
              {time(e.firstReceivedAt)}
              {e.processingError ? ` | ${e.processingError}` : ""}
            </div>
          </li>
        ))}
    </ol>
  );
}

function IncidentPanel({
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
      <Drawer title="Incident" onClose={onClose}>
        <p className="text-sm text-zinc-500">Loading...</p>
      </Drawer>
    );
  }

  const { incident, events, actions } = detail;
  const ai = incident.aiAnalysis;
  const needActor = !actor.trim();

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
      `Action ${operation === "execute" ? "executed" : operation + "d"}`
    );

  return (
    <Drawer title={incident.summary} onClose={onClose}>
      <div className="flex flex-wrap gap-2">
        <Badge value={incident.severity} />
        <Badge value={incident.status} />
        <span className="text-xs text-zinc-500">{incident.type}</span>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
        <dt className="text-zinc-500">Order</dt>
        <dd className="font-mono text-xs">{incident.orderId}</dd>
        <dt className="text-zinc-500">PayPal</dt>
        <dd><Badge value={incident.paypalStatus} /></dd>
        <dt className="text-zinc-500">Local</dt>
        <dd><Badge value={incident.localStatus} /></dd>
        <dt className="text-zinc-500">Financial impact</dt>
        <dd>{money(incident.financialImpact)}</dd>
        <dt className="text-zinc-500">Detected</dt>
        <dd>{time(incident.detectedAt)}</dd>
      </dl>

      <section className="mt-6">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-medium">AI investigation</h3>
          <button
            disabled={investigating}
            onClick={async () => {
              setInvestigating(true);
              await run("investigate", () => api.investigate(id), "Investigation complete");
              await load();
              setInvestigating(false);
            }}
            className="rounded bg-violet-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
          >
            {investigating ? "Investigating..." : ai ? "Re-investigate" : "Investigate with AI"}
          </button>
        </div>
        {ai ? (
          <div className="space-y-3 rounded border border-violet-200 bg-violet-50 p-3 text-sm dark:border-violet-900 dark:bg-violet-950/40">
            <p>
              <span className="font-medium">Root cause:</span> {ai.rootCause}{" "}
              <span className="text-xs text-zinc-500">({ai.confidence} confidence)</span>
            </p>
            <p className="whitespace-pre-line">{ai.explanation}</p>
            <p><span className="font-medium">Financial impact:</span> {ai.financialImpact.summary}</p>
            <p><span className="font-medium">Customer impact:</span> {ai.customerImpact}</p>
            {ai.recommendedActions.length > 0 && (
              <div>
                <p className="font-medium">Recommended</p>
                <ul className="list-disc pl-5">
                  {ai.recommendedActions.map((r, i) => (
                    <li key={i}>
                      <span className="font-mono text-xs">{r.type}</span> ({r.risk} risk): {r.description}
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-zinc-500">Saved as proposals below. Nothing runs until a person approves it.</p>
              </div>
            )}
            {ai.evidenceAssessment.length > 0 && (
              <ul className="list-disc pl-5 text-xs">
                {ai.evidenceAssessment.map((e, i) => (
                  <li key={i}><span className="font-mono">{e.reference}</span>: {e.interpretation}</li>
                ))}
              </ul>
            )}
            <p className="text-xs text-zinc-500">{ai.model} | {time(ai.generatedAt)}</p>
          </div>
        ) : (
          <p className="text-sm text-zinc-500">Not investigated yet.</p>
        )}
      </section>

      <section className="mt-6">
        <h3 className="mb-2 text-sm font-medium">Recovery actions</h3>
        {needActor && (
          <p className="mb-2 text-xs text-amber-700 dark:text-amber-400">Enter your name in the Acting as box to approve or execute.</p>
        )}
        {actions.length === 0 && <p className="text-sm text-zinc-500">No actions proposed.</p>}
        <ul className="space-y-2">
          {actions.map((a) => (
            <li key={a.id} className="rounded border border-zinc-200 p-3 text-sm dark:border-zinc-700">
              <div className="flex flex-wrap items-center gap-2">
                <Badge value={a.status} />
                <span className="font-medium">{a.type}</span>
                {a.financial && <span className="rounded bg-red-600 px-1.5 text-xs text-white">moves money</span>}
                {a.params.amount && <span className="text-xs">{money(a.params.amount)}</span>}
              </div>
              <p className="mt-1">{a.rationale}</p>
              <ol className="mt-2 space-y-0.5 border-l border-zinc-200 pl-3 text-xs text-zinc-500 dark:border-zinc-700">
                {a.audit.map((entry, i) => (
                  <li key={i}>
                    <span className="font-medium text-zinc-700 dark:text-zinc-300">{entry.event}</span> by {entry.actor}, {time(entry.at)}
                    {entry.detail && entry.event !== "PROPOSED" ? `: ${entry.detail}` : ""}
                  </li>
                ))}
              </ol>
              {a.status === "PROPOSED" && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {a.financial && (
                    <label className="flex items-center gap-1 text-xs">
                      <input
                        type="checkbox"
                        checked={!!ack[a.id]}
                        onChange={(e) => setAck({ ...ack, [a.id]: e.target.checked })}
                      />
                      I understand this moves real money
                    </label>
                  )}
                  <button
                    disabled={needActor || (a.financial && !ack[a.id])}
                    onClick={() => decide(a, "approve")}
                    className="rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
                  >
                    Approve
                  </button>
                  <button
                    disabled={needActor}
                    onClick={() => decide(a, "reject")}
                    className="rounded border border-zinc-300 px-2 py-1 text-xs disabled:opacity-40 dark:border-zinc-600"
                  >
                    Reject
                  </button>
                </div>
              )}
              {a.status === "APPROVED" && (
                <button
                  disabled={needActor}
                  onClick={() => decide(a, "execute")}
                  className="mt-2 rounded bg-zinc-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
                >
                  Execute
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-6">
        <h3 className="mb-2 text-sm font-medium">Evidence</h3>
        <ul className="space-y-1 text-xs">
          {incident.evidence.map((e, i) => (
            <li key={i}>
              <span className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">{e.source}</span>{" "}
              <span className="font-mono">{e.reference}</span>: {e.detail}
            </li>
          ))}
        </ul>
        <h3 className="mt-4 mb-2 text-sm font-medium">Webhook timeline</h3>
        <EventTimeline events={events} />
      </section>
    </Drawer>
  );
}
