"use client";

import {
  AllCommunityModule,
  colorSchemeDark,
  colorSchemeLight,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
  type RowClassParams,
  type RowClickedEvent,
  type RowStyle,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Incident, Money, RecoveryAction, Transaction } from "@/lib/domain/types";
import { api, setPasscode, type AppConfig, type EventRow } from "./api";
import PayPalCheckout from "./checkout";
import { EventTimeline, IncidentPanel } from "./incident-panel";
import { proposerLabel } from "./incident-panel";
import { button, Card, ConfidenceMeter, Drawer, humanize, Icon, input, Kpi, Logo, money, Reconciliation, Severity, shortTime, Status, Tag, ThemeToggle, Toast, type Notice, type ThemePreference } from "./ui";

ModuleRegistry.registerModules([AllCommunityModule]);

type Tab = "incidents" | "transactions" | "events" | "actions";

const tagCell = (p: { value?: string | null }) => <Tag value={p.value} />;
const statusCell = (p: { value?: string | null }) => <Status value={p.value} />;
const severityCell = (p: { value?: string | null }) => <Severity value={p.value} />;
const reconciliationCell = (p: { value?: string | null }) => <Reconciliation value={p.value} />;
const monoCell = (p: { value?: string | null }) => <span className="font-mono text-xs">{p.value ?? "-"}</span>;

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
    cellClass: "tabular-nums",
    width: 130,
  };
}

function reconciliationState(tx: Transaction): string {
  if (!tx.lastReconciledAt || !tx.paypalStatus) return "NOT CHECKED";
  return tx.paypalStatus === tx.localStatus ? "IN SYNC" : "MISMATCH";
}

// inline style so it wins over the grid theme's row background
const ALERT_ROW: RowStyle = { background: "rgba(239, 68, 68, 0.05)" };
const incidentRowStyle = (p: RowClassParams<Incident>) =>
  p.data?.status === "OPEN" && (p.data.severity === "CRITICAL" || p.data.severity === "HIGH") ? ALERT_ROW : undefined;
const transactionRowStyle = (p: RowClassParams<Transaction>) =>
  p.data && reconciliationState(p.data) === "MISMATCH" ? ALERT_ROW : undefined;

const CURRENCIES = ["EUR", "USD", "GBP"];

const EMPTY: Record<Tab, string> = {
  incidents: "No incidents. Pay with the test checkout, then use Reconcile all.",
  transactions: "No transactions yet. Use the PayPal button above to make a sandbox payment.",
  events: "No webhook events yet. Register the webhook URL on your PayPal app to receive them.",
  actions: "No recovery actions yet. They appear when an incident is detected or investigated.",
};

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

// Light by default; the layout's inline script applies a saved choice before first paint.
function useTheme(): [ThemePreference, (value: ThemePreference) => void, boolean] {
  const [preference, setPreference] = useState<ThemePreference>("light");
  const systemDark = usePrefersDark();

  useEffect(() => {
    try {
      const saved = localStorage.getItem("paytrace.theme");
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time restore from storage
      if (saved === "dark" || saved === "system") setPreference(saved);
    } catch {
      /* storage unavailable */
    }
  }, []);

  const dark = preference === "dark" || (preference === "system" && systemDark);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  const update = (value: ThemePreference) => {
    setPreference(value);
    try {
      localStorage.setItem("paytrace.theme", value);
    } catch {
      /* storage unavailable */
    }
  };
  return [preference, update, dark];
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

function useSecondsSince(timestamp: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  return timestamp ? Math.max(0, Math.round((now - timestamp) / 1000)) : null;
}

export default function Dashboard() {
  const [themePreference, setThemePreference, dark] = useTheme();
  const theme = useMemo(
    () =>
      themeQuartz.withPart(dark ? colorSchemeDark : colorSchemeLight).withParams({
        accentColor: dark ? "#a1a1aa" : "#18181b",
        fontFamily: "inherit",
        fontSize: 13,
        headerFontWeight: 600,
        rowHeight: 42,
        headerHeight: 40,
        wrapperBorder: false,
        wrapperBorderRadius: 0,
        rowHoverColor: dark ? "rgba(255, 255, 255, 0.04)" : "rgba(0, 0, 0, 0.025)",
        backgroundColor: dark ? "#18181b" : "#ffffff",
        chromeBackgroundColor: dark ? "#1f1f23" : "#fafafa",
        headerTextColor: dark ? "#a1a1aa" : "#52525b",
        oddRowBackgroundColor: dark ? "#18181b" : "#ffffff",
      }),
    [dark]
  );

  const [tab, setTab] = useState<Tab>("incidents");
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [actions, setActions] = useState<RecoveryAction[]>([]);
  const [selectedIncident, setSelectedIncident] = useState<string | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [actor, setActor] = useActorName();
  const [newOrder, setNewOrder] = useState({ amount: "10.00", currency: "EUR" });
  const [approveUrl, setApproveUrl] = useState<string | null>(null);
  const [refreshCount, setRefreshCount] = useState(0);
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [passcode, setPasscodeInput] = useState("");
  const [search, setSearch] = useState("");
  const secondsSinceRefresh = useSecondsSince(lastRefreshAt);

  useEffect(() => {
    api.config().then(setConfig).catch(() => setConfig(null));
  }, []);

  const updatePasscode = (value: string) => {
    setPasscodeInput(value);
    setPasscode(value);
  };

  const refresh = useCallback(async () => {
    try {
      const [t, e, i, a] = await Promise.all([api.transactions(), api.events(), api.incidents(), api.actions()]);
      setTransactions(t);
      setEvents(e);
      setIncidents(i);
      setActions(a);
      setRefreshCount((n) => n + 1);
      setLastRefreshAt(Date.now());
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

  const dismissNotice = useCallback(() => setNotice(null), []);

  const openIncidents = incidents.filter((i) => i.status === "OPEN");
  const criticalOpen = openIncidents.filter((i) => i.severity === "CRITICAL").length;
  const atRisk = Object.entries(
    openIncidents.reduce<Record<string, number>>((acc, i) => {
      if (i.financialImpact) {
        acc[i.financialImpact.currency] = (acc[i.financialImpact.currency] ?? 0) + Number(i.financialImpact.value);
      }
      return acc;
    }, {})
  ).sort((a, b) => b[1] - a[1]);
  const checked = transactions.filter((t) => reconciliationState(t) !== "NOT CHECKED");
  const mismatched = transactions.filter((t) => reconciliationState(t) === "MISMATCH").length;
  const pendingApproval = actions.filter((a) => a.status === "PROPOSED").length;
  const failedEvents = events.filter((e) => e.processingStatus === "FAILED").length;
  const duplicateDeliveries = events.reduce((n, e) => n + Math.max(0, e.deliveryCount - 1), 0);

  const awaitingApproval = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of actions) if (a.status === "PROPOSED") counts[a.incidentId] = (counts[a.incidentId] ?? 0) + 1;
    return counts;
  }, [actions]);

  // open first, then worst first, then most recent
  const incidentCols = useMemo<ColDef<Incident>[]>(
    () => [
      { field: "status", cellRenderer: tagCell, width: 110, pinned: "left" },
      {
        field: "severity",
        cellRenderer: severityCell,
        width: 155,
        pinned: "left",
        // one sort key: open incidents first, then by severity
        comparator: (a: string, b: string, nodeA, nodeB) =>
          (nodeA.data?.status === "OPEN" ? 10 : 0) + (SEVERITY_RANK[a] ?? 0) -
          ((nodeB.data?.status === "OPEN" ? 10 : 0) + (SEVERITY_RANK[b] ?? 0)),
        sort: "desc",
        sortIndex: 0,
      },
      { field: "type", flex: 1, minWidth: 150, cellClass: "font-medium", valueFormatter: (p) => (p.value ? humanize(p.value) : "") },
      { field: "paypalStatus", headerName: "PayPal", cellRenderer: statusCell, width: 120 },
      { field: "localStatus", headerName: "Local", cellRenderer: statusCell, width: 120 },
      { ...moneyColumn<Incident>("At risk", (i) => i.financialImpact), width: 115 },
      {
        headerName: "AI analysis",
        valueGetter: (p) => p.data?.aiAnalysis?.confidence ?? null,
        cellRenderer: (p: { value: "LOW" | "MEDIUM" | "HIGH" | null }) =>
          p.value ? <ConfidenceMeter level={p.value} /> : <span className="text-[13px] text-zinc-400">Not run</span>,
        width: 155,
      },
      {
        headerName: "Approvals",
        valueGetter: (p) => (p.data ? awaitingApproval[p.data.id] ?? 0 : 0),
        cellRenderer: (p: { value: number }) => (p.value ? <Tag tone="blue">{p.value} pending</Tag> : <span className="text-zinc-400">-</span>),
        filter: "agNumberColumnFilter",
        width: 115,
      },
      { field: "orderId", headerName: "Order", cellRenderer: monoCell, width: 170 },
      { field: "lastSeenAt", headerName: "Last seen", valueFormatter: (p) => shortTime(p.value), width: 160, sort: "desc", sortIndex: 1 },
    ],
    [awaitingApproval]
  );

  const transactionCols = useMemo<ColDef<Transaction>[]>(
    () => [
      {
        headerName: "Reconciliation",
        valueGetter: (p) => (p.data ? reconciliationState(p.data) : null),
        cellRenderer: reconciliationCell,
        width: 150,
        pinned: "left",
      },
      { field: "orderId", cellRenderer: monoCell, width: 190, pinned: "left" },
      { field: "localStatus", headerName: "Local", cellRenderer: statusCell, width: 160 },
      { field: "paypalStatus", headerName: "PayPal (last seen)", cellRenderer: statusCell, width: 170 },
      moneyColumn<Transaction>("Amount", (t) => t.amount),
      { field: "captureId", cellRenderer: monoCell, width: 190 },
      { field: "lastUpdatedBy", headerName: "Updated by", width: 120 },
      { field: "lastReconciledAt", headerName: "Reconciled", valueFormatter: (p) => shortTime(p.value), width: 140 },
      { field: "updatedAt", headerName: "Updated", valueFormatter: (p) => shortTime(p.value), flex: 1, minWidth: 140, sort: "desc" },
    ],
    []
  );

  const eventCols = useMemo<ColDef<EventRow>[]>(
    () => [
      { field: "eventType", cellRenderer: monoCell, width: 250 },
      { field: "processingStatus", headerName: "Processing", cellRenderer: statusCell, width: 140 },
      { field: "verification", cellRenderer: statusCell, width: 190 },
      { field: "orderId", cellRenderer: monoCell, width: 190 },
      { field: "captureId", cellRenderer: monoCell, width: 190 },
      { field: "resourceStatus", headerName: "Resource status", width: 140 },
      moneyColumn<EventRow>("Amount", (e) => e.amount),
      { field: "deliveryCount", headerName: "Deliveries", filter: "agNumberColumnFilter", type: "rightAligned", width: 120 },
      { field: "processingError", headerName: "Note", flex: 1, minWidth: 200 },
      { field: "lastReceivedAt", headerName: "Received", valueFormatter: (p) => shortTime(p.value), width: 140, sort: "desc" },
    ],
    []
  );

  const actionCols = useMemo<ColDef<RecoveryAction>[]>(
    () => [
      { field: "status", cellRenderer: tagCell, width: 130, pinned: "left" },
      { field: "type", width: 200, valueFormatter: (p) => (p.value ? humanize(p.value) : "") },
      {
        field: "financial",
        headerName: "Moves money",
        cellRenderer: (p: { value: boolean }) => (p.value ? <Tag tone="red">Yes</Tag> : <span className="text-zinc-400">-</span>),
        width: 130,
      },
      moneyColumn<RecoveryAction>("Amount", (a) => a.params.amount),
      { field: "orderId", cellRenderer: monoCell, width: 190 },
      { field: "rationale", flex: 2, minWidth: 260 },
      {
        field: "proposedBy",
        width: 170,
        valueFormatter: (p) => (p.value ? proposerLabel(p.value) : ""),
      },
      { field: "decidedBy", width: 130 },
      { field: "proposedAt", headerName: "Proposed", valueFormatter: (p) => shortTime(p.value), width: 140, sort: "desc" },
    ],
    []
  );

  const defaultColDef = useMemo<ColDef>(() => ({ sortable: true, filter: true, resizable: true }), []);
  const overlay = (text: string) => `<span style="padding:2rem;color:#71717a;font-size:13px">${text}</span>`;

  const grid = (() => {
    const shared = {
      theme,
      defaultColDef,
      quickFilterText: search,
      overlayNoRowsTemplate: overlay(EMPTY[tab]),
      domLayout: "autoHeight" as const,
      pagination: true,
      paginationPageSize: 10,
      paginationPageSizeSelector: [10, 25, 50],
      suppressCellFocus: true,
    };
    switch (tab) {
      case "incidents":
        return (
          <AgGridReact<Incident>
            {...shared}
            rowData={incidents}
            columnDefs={incidentCols}
            getRowId={(p) => p.data.id}
            getRowStyle={incidentRowStyle}
            onRowClicked={(e: RowClickedEvent<Incident>) => e.data && setSelectedIncident(e.data.id)}
          />
        );
      case "transactions":
        return (
          <AgGridReact<Transaction>
            {...shared}
            rowData={transactions}
            columnDefs={transactionCols}
            getRowId={(p) => p.data.orderId}
            getRowStyle={transactionRowStyle}
            onRowClicked={(e: RowClickedEvent<Transaction>) => e.data && setSelectedOrder(e.data.orderId)}
          />
        );
      case "events":
        return <AgGridReact<EventRow> {...shared} rowData={events} columnDefs={eventCols} getRowId={(p) => p.data.eventId} />;
      case "actions":
        return (
          <AgGridReact<RecoveryAction>
            {...shared}
            rowData={actions}
            columnDefs={actionCols}
            getRowId={(p) => p.data.id}
            onRowClicked={(e: RowClickedEvent<RecoveryAction>) => e.data && setSelectedIncident(e.data.incidentId)}
          />
        );
    }
  })();

  const selectedTx = transactions.find((t) => t.orderId === selectedOrder) ?? null;

  const tabs: [Tab, string, number][] = [
    ["incidents", "Incidents", openIncidents.length],
    ["transactions", "Transactions", transactions.length],
    ["events", "Webhook events", events.length],
    ["actions", "Recovery actions", actions.length],
  ];

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="sticky top-0 z-40 border-b border-zinc-200 bg-white/85 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/85">
        <div className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 2xl:px-10">
          <div className="flex items-center gap-3">
            <Logo />
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-semibold tracking-tight">PayTrace AI</h1>
                <Tag tone="amber">Sandbox</Tag>
              </div>
              <p className="text-xs text-zinc-500">Payment observability and recovery for PayPal merchants</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="hidden items-center gap-1.5 text-xs text-zinc-500 md:inline-flex">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              {secondsSinceRefresh === null ? "Connecting..." : `Live, updated ${secondsSinceRefresh}s ago`}
            </span>
            <ThemeToggle value={themePreference} onChange={(v: ThemePreference) => setThemePreference(v)} />
            <input value={actor} onChange={(e) => setActor(e.target.value)} placeholder="Acting as (your name)" aria-label="Acting as" className={`${input} w-44`} />
            {config?.passcodeRequired && (
              <input
                type="password"
                value={passcode}
                onChange={(e) => updatePasscode(e.target.value)}
                placeholder="Approver passcode"
                aria-label="Approver passcode"
                className={`${input} w-40`}
              />
            )}
            <button
              onClick={() =>
                run("reconcile", async () => {
                  const r = await api.reconcileAll();
                  const failed = r.errors.length ? `, ${r.errors.length} could not be checked` : "";
                  setNotice({ kind: r.errors.length ? "error" : "ok", text: `Checked ${r.reconciled} orders against PayPal: ${r.inSync} in sync${failed}` });
                })
              }
              disabled={busy !== null}
              className={button.primary}
            >
              <Icon name="refresh" className={`size-3.5 ${busy === "reconcile" ? "animate-spin" : ""}`} />
              {busy === "reconcile" ? "Reconciling..." : "Reconcile all"}
            </button>
          </div>
        </div>
      </header>

      <main className="flex w-full flex-col gap-5 px-4 py-5 sm:px-6 2xl:px-10">
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Kpi
            label="Open incidents"
            value={openIncidents.length}
            sub={criticalOpen ? `${criticalOpen} critical` : "nothing critical"}
            alert={openIncidents.length > 0}
            onClick={() => setTab("incidents")}
          />
          <Kpi
            label="Money at risk"
            value={
              atRisk.length ? (
                <>
                  <span className="mr-1 text-[0.6em] font-medium">{atRisk[0][0]}</span>
                  {atRisk[0][1].toFixed(2)}
                </>
              ) : (
                "0.00"
              )
            }
            sub={
              atRisk.length > 1
                ? `+ ${atRisk.slice(1).map(([c, v]) => `${c} ${v.toFixed(2)}`).join(", ")}`
                : "across open incidents"
            }
            alert={atRisk.length > 0}
          />
          <Kpi label="Awaiting approval" value={pendingApproval} sub="proposed recovery actions" onClick={() => setTab("actions")} />
          <Kpi
            label="Reconciliation"
            value={checked.length ? `${checked.length - mismatched}/${checked.length}` : "-"}
            sub={mismatched ? `${mismatched} out of sync with PayPal` : "orders in sync with PayPal"}
            alert={mismatched > 0}
            onClick={() => setTab("transactions")}
          />
          <Kpi
            label="Webhook events"
            value={events.length}
            sub={`${failedEvents} failed, ${duplicateDeliveries} duplicates absorbed`}
            onClick={() => setTab("events")}
          />
        </section>

        <section className="grid gap-3 lg:grid-cols-5">
          <Card title="Test checkout" className="lg:col-span-2" aside={<span className="text-xs text-zinc-500">PayPal Sandbox buyer</span>}>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={newOrder.amount}
                onChange={(e) => setNewOrder({ ...newOrder, amount: e.target.value })}
                aria-label="Amount"
                className={`${input} w-24 tabular-nums`}
              />
              <select
                value={newOrder.currency}
                onChange={(e) => setNewOrder({ ...newOrder, currency: e.target.value })}
                aria-label="Currency"
                className={input}
              >
                {CURRENCIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
              <button
                disabled={busy !== null}
                onClick={() =>
                  run("create", async () => {
                    const r = await api.createOrder(newOrder.amount, newOrder.currency);
                    setApproveUrl(r.approveUrl);
                    setNotice({ kind: "ok", text: `Created order ${r.orderId} without paying. Approve it, then capture it from Transactions.` });
                  })
                }
                className={button.secondary}
              >
                Create order only
              </button>
            </div>
            {config?.paypalClientId && /^\d+(\.\d{1,2})?$/.test(newOrder.amount) && (
              <div className="mt-3 max-w-sm">
                <PayPalCheckout
                  clientId={config.paypalClientId}
                  amount={newOrder.amount}
                  currency={newOrder.currency}
                  onCaptured={(orderId, status) => {
                    setNotice({ kind: "ok", text: `Paid with PayPal: order ${orderId}, capture ${status ?? "submitted"}` });
                    void refresh();
                  }}
                  onError={(message) => setNotice({ kind: "error", text: message })}
                />
              </div>
            )}
            {approveUrl && (
              <a href={approveUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-[13px] font-medium text-sky-700 underline-offset-2 hover:underline dark:text-sky-400">
                Open PayPal approval page
              </a>
            )}
          </Card>

          <Card title="How an incident gets handled" className="lg:col-span-3">
            <ol className="grid text-xs sm:grid-cols-5 sm:divide-x sm:divide-zinc-200 dark:sm:divide-zinc-800">
              {[
                ["Detect", "Reconciliation compares live PayPal state with our record."],
                ["Investigate", "AI reads the evidence and explains cause and impact."],
                ["Propose", "AI and the system can suggest fixes, nothing more."],
                ["Approve", "A person decides. Refunds need a second confirmation."],
                ["Execute", "PayPal is re-checked, the fix runs, every step is logged."],
              ].map(([title, text], i) => (
                <li key={title} className="py-2 sm:px-3 sm:py-0 sm:first:pl-0 sm:last:pr-0">
                  <div className="font-mono text-[11px] text-zinc-400">0{i + 1}</div>
                  <div className="mt-0.5 text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">{title}</div>
                  <p className="mt-1 leading-relaxed text-zinc-500">{text}</p>
                </li>
              ))}
            </ol>
          </Card>
        </section>

        <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 px-3 py-2.5 dark:border-zinc-800">
            <nav className="flex flex-wrap gap-0.5 rounded-md bg-zinc-100 p-0.5 dark:bg-zinc-800/70" aria-label="Views">
              {tabs.map(([key, label, count]) => (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  className={`flex items-center gap-2 rounded-[5px] px-3 py-1.5 text-[13px] font-medium transition-colors ${
                    tab === key
                      ? "bg-white text-zinc-900 shadow-[0_1px_2px_rgba(0,0,0,0.08)] dark:bg-zinc-950 dark:text-zinc-100"
                      : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                  }`}
                >
                  {label}
                  <span
                    className={`min-w-5 rounded-[3px] px-1 text-center text-[11px] font-medium tabular-nums ${
                      key === "incidents" && count > 0 ? "bg-red-600 text-white" : "bg-zinc-200/80 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300"
                    }`}
                  >
                    {count}
                  </span>
                </button>
              ))}
            </nav>
            <label className="relative">
              <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search orders, captures, events..."
                aria-label="Search grid"
                className={`${input} w-72 pl-8`}
              />
            </label>
          </div>
          {/* keyed per tab: each view gets its own grid instance, otherwise column state leaks between tabs */}
          <div key={tab}>{grid}</div>
        </section>
      </main>

      <Toast notice={notice} onClose={dismissNotice} />

      {selectedIncident && (
        <IncidentPanel
          id={selectedIncident}
          actor={actor}
          refreshCount={refreshCount}
          aiProvider={config?.aiProvider ?? null}
          onClose={() => setSelectedIncident(null)}
          run={run}
        />
      )}

      {selectedTx && (
        <Drawer
          title={<span className="font-mono">{selectedTx.orderId}</span>}
          eyebrow={
            <>
              <Reconciliation value={reconciliationState(selectedTx)} />
              <span className="text-xs font-medium text-zinc-500">PayPal order</span>
            </>
          }
          onClose={() => setSelectedOrder(null)}
        >
          <dl className="grid grid-cols-2 gap-3 rounded-xl border border-zinc-200 bg-white p-4 text-sm dark:border-zinc-800 dark:bg-zinc-900">
            <div>
              <dt className="text-xs text-zinc-500">Our record</dt>
              <dd className="mt-1"><Status value={selectedTx.localStatus} /></dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-500">PayPal (last seen)</dt>
              <dd className="mt-1"><Status value={selectedTx.paypalStatus} /></dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-500">Amount</dt>
              <dd className="mt-1 font-semibold tabular-nums">{money(selectedTx.amount)}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-500">Capture</dt>
              <dd className="mt-1 truncate font-mono text-xs">{selectedTx.captureId ?? "-"}</dd>
            </div>
          </dl>

          <div className="flex flex-wrap gap-2">
            <button
              disabled={busy !== null}
              onClick={() => run("reconcile-one", () => api.reconcile(selectedTx.orderId), "Order reconciled against PayPal")}
              className={button.primary}
            >
              <Icon name="refresh" className="size-3.5" /> Reconcile with PayPal
            </button>
            {(selectedTx.localStatus === "APPROVED" || selectedTx.localStatus === "CREATED") && (
              <button
                disabled={busy !== null}
                onClick={() => run("capture", () => api.captureOrder(selectedTx.orderId), "Capture submitted")}
                className={button.secondary}
              >
                Capture payment
              </button>
            )}
          </div>

          {config?.demoTools && selectedTx.localStatus === "COMPLETED" && (
            <div className="rounded-xl border border-dashed border-amber-400 bg-amber-50/60 p-4 text-sm dark:border-amber-700 dark:bg-amber-500/5">
              <p className="font-semibold text-amber-900 dark:text-amber-200">Demo: simulate a lost update</p>
              <p className="mt-1 text-xs text-amber-800/80 dark:text-amber-200/70">
                Pretends our app crashed right after PayPal captured the payment, so the order is still PENDING locally.
              </p>
              <button
                disabled={busy !== null}
                onClick={() =>
                  run(
                    "stage",
                    async () => {
                      await api.stageLocalStatus(selectedTx.orderId, "PENDING");
                      const result = await api.reconcile(selectedTx.orderId);
                      const incident = result.openIncidents[0];
                      if (incident) {
                        setSelectedOrder(null);
                        setSelectedIncident(incident.id);
                      }
                    },
                    "Local record set to PENDING and reconciled against PayPal"
                  )
                }
                className="mt-3 inline-flex items-center rounded-md bg-amber-500 px-3 py-1.5 text-sm font-medium text-amber-950 shadow-sm transition hover:bg-amber-400 disabled:opacity-50"
              >
                Simulate lost update
              </button>
            </div>
          )}

          {incidents.some((i) => i.orderId === selectedTx.orderId) && (
            <Card title="Incidents">
              <ul className="space-y-1">
                {incidents
                  .filter((i) => i.orderId === selectedTx.orderId)
                  .map((i) => (
                    <li key={i.id}>
                      <button
                        onClick={() => {
                          setSelectedOrder(null);
                          setSelectedIncident(i.id);
                        }}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      >
                        <Severity value={i.severity} /> <Tag value={i.status} />
                        <span className="flex-1 truncate">{i.summary}</span>
                        <Icon name="arrow" className="size-4 text-zinc-400" />
                      </button>
                    </li>
                  ))}
              </ul>
            </Card>
          )}

          <Card title="Webhook events">
            <EventTimeline events={events.filter((e) => e.orderId === selectedTx.orderId)} />
          </Card>
        </Drawer>
      )}
    </div>
  );
}
