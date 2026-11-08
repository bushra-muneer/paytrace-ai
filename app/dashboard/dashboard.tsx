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
import { IdentityMenu } from "./identity-menu";
import { EventTimeline, IncidentPanel, proposerLabel } from "./incident-panel";
import {
  button,
  Card,
  ConfidenceMeter,
  Drawer,
  formatAmount,
  humanize,
  Icon,
  input,
  Logo,
  Modal,
  money,
  Reconciliation,
  relativeTime,
  Severity,
  shortTime,
  Stat,
  Status,
  Tag,
  ThemeToggle,
  Toast,
  type Notice,
  type ThemePreference,
} from "./ui";

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

// Status views: quick filters above each grid. The first entry of each list is the default.
interface StatusView<T> {
  key: string;
  label: string;
  match: (row: T) => boolean;
  attention?: boolean; // highlight the count when it isn't zero
}

const INCIDENT_VIEWS: StatusView<Incident>[] = [
  { key: "open", label: "Open", match: (i) => i.status === "OPEN", attention: true },
  { key: "resolved", label: "Resolved", match: (i) => i.status === "RESOLVED" },
  { key: "all", label: "All", match: () => true },
];

const TRANSACTION_VIEWS: StatusView<Transaction>[] = [
  { key: "all", label: "All", match: () => true },
  { key: "mismatch", label: "Mismatch", match: (t) => reconciliationState(t) === "MISMATCH", attention: true },
  { key: "in-sync", label: "In sync", match: (t) => reconciliationState(t) === "IN SYNC" },
  { key: "unchecked", label: "Not checked", match: (t) => reconciliationState(t) === "NOT CHECKED" },
];

const EVENT_VIEWS: StatusView<EventRow>[] = [
  { key: "all", label: "All", match: () => true },
  { key: "processed", label: "Changed state", match: (e) => e.processingStatus === "PROCESSED" },
  { key: "confirmed", label: "Confirmed", match: (e) => e.processingStatus === "CONFIRMED" },
  { key: "ignored", label: "Ignored", match: (e) => e.processingStatus === "IGNORED" },
  { key: "failed", label: "Failed", match: (e) => e.processingStatus === "FAILED", attention: true },
];

const ACTION_VIEWS: StatusView<RecoveryAction>[] = [
  { key: "all", label: "All", match: () => true },
  { key: "proposed", label: "Awaiting approval", match: (a) => a.status === "PROPOSED" },
  { key: "approved", label: "Approved", match: (a) => a.status === "APPROVED" },
  { key: "attention", label: "Needs attention", match: (a) => a.status === "FAILED" || a.status === "UNCERTAIN", attention: true },
  { key: "executed", label: "Executed", match: (a) => a.status === "EXECUTED" },
  { key: "rejected", label: "Rejected", match: (a) => a.status === "REJECTED" },
];

const DEFAULT_VIEWS: Record<Tab, string> = {
  incidents: INCIDENT_VIEWS[0].key,
  transactions: TRANSACTION_VIEWS[0].key,
  events: EVENT_VIEWS[0].key,
  actions: ACTION_VIEWS[0].key,
};

function applyView<T>(rows: T[], views: StatusView<T>[], key: string): T[] {
  const view = views.find((v) => v.key === key) ?? views[0];
  return rows.filter(view.match);
}

function countViews<T>(rows: T[], views: StatusView<T>[]) {
  return views.map((v) => ({ key: v.key, label: v.label, attention: v.attention, count: rows.filter(v.match).length }));
}

interface ActivityItem {
  key: string;
  at: string;
  title: string;
  detail: string;
  tone: "red" | "green" | "blue" | "gray";
  incidentId?: string;
}

const ACTIVITY_DOT: Record<ActivityItem["tone"], string> = {
  red: "bg-red-500",
  green: "bg-emerald-500",
  blue: "bg-sky-500",
  gray: "bg-zinc-300 dark:bg-zinc-600",
};

const ACTION_NAME: Record<RecoveryAction["type"], string> = {
  SYNC_LOCAL_STATUS: "Status sync",
  CREATE_LOCAL_RECORD: "Record creation",
  REFUND_CAPTURE: "Refund",
};

// audit events worth surfacing, and how they read in the feed
const ACTIVITY_EVENTS: Record<string, [string, ActivityItem["tone"]]> = {
  APPROVED: ["approved", "blue"],
  EXECUTED: ["executed", "green"],
  REJECTED: ["rejected", "gray"],
  FAILED: ["failed", "red"],
  UNCERTAIN: ["outcome unknown", "red"],
};

const SECTIONS: Record<Tab, { title: string; description: string }> = {
  incidents: { title: "Incidents", description: "Where PayPal and our records disagree. Open and most severe first." },
  transactions: { title: "Transactions", description: "Every PayPal order we know about, and whether it still matches PayPal." },
  events: { title: "Webhook events", description: "Notifications from PayPal, signature-checked and de-duplicated by event ID." },
  actions: { title: "Recovery actions", description: "Fixes proposed by reconciliation, the AI or a person, and who approved them." },
};

const EMPTY: Record<Tab, string> = {
  incidents: "No open problems. Everything we know about matches PayPal.",
  transactions: "No transactions yet. Use New test payment to make a sandbox payment.",
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
        headerFontSize: 12,
        headerFontWeight: 500,
        rowHeight: 44,
        headerHeight: 38,
        cellHorizontalPadding: 16,
        iconSize: 14,
        columnBorder: false,
        headerColumnBorder: false,
        headerColumnResizeHandleColor: "transparent",
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
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [refreshCount, setRefreshCount] = useState(0);
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [passcode, setPasscodeInput] = useState("");
  const [search, setSearch] = useState("");
  const [views, setViews] = useState<Record<Tab, string>>(DEFAULT_VIEWS);
  const showView = (target: Tab, key: string) => {
    setTab(target);
    setViews((v) => ({ ...v, [target]: key }));
  };
  const secondsSinceRefresh = useSecondsSince(lastRefreshAt);

  useEffect(() => {
    api.config().then(setConfig).catch(() => setConfig(null));
  }, []);

  // kept per browser tab, so a refresh while recording doesn't clear it
  const updatePasscode = (value: string) => {
    setPasscodeInput(value);
    setPasscode(value);
    try {
      sessionStorage.setItem("paytrace.passcode", value);
    } catch {
      /* storage unavailable */
    }
  };

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem("paytrace.passcode");
      if (saved) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time restore from storage
        setPasscodeInput(saved);
        setPasscode(saved);
      }
    } catch {
      /* storage unavailable */
    }
  }, []);

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
  const verifiedEvents = events.filter((e) => e.verification === "VERIFIED").length;
  const loaded = lastRefreshAt !== null;

  const shownIncidents = useMemo(() => applyView(incidents, INCIDENT_VIEWS, views.incidents), [incidents, views.incidents]);
  const shownTransactions = useMemo(() => applyView(transactions, TRANSACTION_VIEWS, views.transactions), [transactions, views.transactions]);
  const shownEvents = useMemo(() => applyView(events, EVENT_VIEWS, views.events), [events, views.events]);
  const shownActions = useMemo(() => applyView(actions, ACTION_VIEWS, views.actions), [actions, views.actions]);

  const viewChips = useMemo(() => {
    switch (tab) {
      case "incidents":
        return countViews(incidents, INCIDENT_VIEWS);
      case "transactions":
        return countViews(transactions, TRANSACTION_VIEWS);
      case "events":
        return countViews(events, EVENT_VIEWS);
      case "actions":
        return countViews(actions, ACTION_VIEWS);
    }
  }, [tab, incidents, transactions, events, actions]);
  const totalRows = { incidents: incidents.length, transactions: transactions.length, events: events.length, actions: actions.length }[tab];

  const activity = useMemo(() => {
    const items: ActivityItem[] = [];
    for (const i of incidents) {
      items.push({ key: `d-${i.id}`, at: i.detectedAt, title: `${humanize(i.type)} detected`, detail: `${humanize(i.severity)} severity, order ${i.orderId}`, tone: "red", incidentId: i.id });
      if (i.aiAnalysis) {
        items.push({ key: `ai-${i.id}`, at: i.aiAnalysis.generatedAt, title: "AI investigation completed", detail: `${humanize(i.aiAnalysis.confidence)} confidence, order ${i.orderId}`, tone: "blue", incidentId: i.id });
      }
      if (i.resolvedAt) {
        items.push({ key: `r-${i.id}`, at: i.resolvedAt, title: "Incident resolved", detail: `Order ${i.orderId}`, tone: "green", incidentId: i.id });
      }
    }
    for (const a of actions) {
      a.audit.forEach((entry, n) => {
        const shown = ACTIVITY_EVENTS[entry.event];
        if (!shown) return;
        items.push({ key: `a-${a.id}-${n}`, at: entry.at, title: `${ACTION_NAME[a.type]} ${shown[0]}`, detail: `by ${proposerLabel(entry.actor)}, order ${a.orderId}`, tone: shown[1], incidentId: a.incidentId });
      });
    }
    for (const e of events) {
      if (e.verification !== "VERIFIED") continue;
      items.push({ key: `w-${e.eventId}`, at: e.firstReceivedAt, title: "PayPal webhook verified", detail: e.eventType, tone: "gray" });
    }
    return items.sort((x, y) => y.at.localeCompare(x.at)).slice(0, 12);
  }, [incidents, actions, events]);
  const duplicateDeliveries = events.reduce((n, e) => n + Math.max(0, e.deliveryCount - 1), 0);

  const awaitingApproval = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of actions) if (a.status === "PROPOSED") counts[a.incidentId] = (counts[a.incidentId] ?? 0) + 1;
    return counts;
  }, [actions]);

  // open first, then worst first, then most recent
  const incidentCols = useMemo<ColDef<Incident>[]>(
    () => [
      { field: "status", cellRenderer: tagCell, width: 100, pinned: "left" },
      {
        field: "severity",
        cellRenderer: severityCell,
        width: 135,
        pinned: "left",
        // one sort key: open first, then severity, then most recent
        comparator: (a: string, b: string, nodeA, nodeB) =>
          (nodeA.data?.status === "OPEN" ? 10 : 0) + (SEVERITY_RANK[a] ?? 0) -
            ((nodeB.data?.status === "OPEN" ? 10 : 0) + (SEVERITY_RANK[b] ?? 0)) ||
          (nodeA.data?.lastSeenAt ?? "").localeCompare(nodeB.data?.lastSeenAt ?? ""),
        sort: "desc",
      },
      { field: "type", flex: 1.4, minWidth: 140, cellClass: "font-medium", valueFormatter: (p) => (p.value ? humanize(p.value) : "") },
      { field: "paypalStatus", headerName: "PayPal", cellRenderer: statusCell, flex: 1, minWidth: 118 },
      { field: "localStatus", headerName: "Local", cellRenderer: statusCell, flex: 1, minWidth: 118 },
      { ...moneyColumn<Incident>("At risk", (i) => i.financialImpact), flex: 1, minWidth: 100 },
      {
        headerName: "AI analysis",
        valueGetter: (p) => p.data?.aiAnalysis?.confidence ?? null,
        cellRenderer: (p: { value: "LOW" | "MEDIUM" | "HIGH" | null }) =>
          p.value ? <ConfidenceMeter level={p.value} /> : <span className="text-[13px] text-zinc-400">Not run</span>,
        flex: 1.3, minWidth: 152,
      },
      {
        headerName: "Queue",
        headerTooltip: "Recovery actions waiting for approval",
        valueGetter: (p) => (p.data ? awaitingApproval[p.data.id] ?? 0 : 0),
        cellRenderer: (p: { value: number }) => (p.value ? <Tag tone="blue">{p.value} pending</Tag> : <span className="text-zinc-400">-</span>),
        filter: "agNumberColumnFilter",
        flex: 0.8, minWidth: 100,
      },
      { field: "orderId", headerName: "Order", cellRenderer: monoCell, flex: 1.3, minWidth: 168 },
      { field: "lastSeenAt", headerName: "Last seen", valueFormatter: (p) => shortTime(p.value), flex: 1.1, minWidth: 150 },
    ],
    [awaitingApproval]
  );

  const transactionCols = useMemo<ColDef<Transaction>[]>(
    () => [
      {
        headerName: "Reconciliation",
        valueGetter: (p) => (p.data ? reconciliationState(p.data) : null),
        cellRenderer: reconciliationCell,
        width: 130,
        pinned: "left",
      },
      { field: "orderId", cellRenderer: monoCell, width: 175, pinned: "left" },
      { field: "localStatus", headerName: "Local", cellRenderer: statusCell, flex: 1, minWidth: 120 },
      { field: "paypalStatus", headerName: "PayPal", headerTooltip: "PayPal status at the last reconciliation", cellRenderer: statusCell, flex: 1.1, minWidth: 120 },
      { ...moneyColumn<Transaction>("Amount", (t) => t.amount), flex: 0.9, minWidth: 100 },
      { field: "captureId", cellRenderer: monoCell, flex: 1.4, minWidth: 160 },
      { field: "lastUpdatedBy", headerName: "Source", headerTooltip: "What last changed our record", flex: 0.8, minWidth: 90 },
      { field: "lastReconciledAt", headerName: "Reconciled", valueFormatter: (p) => shortTime(p.value), flex: 1, minWidth: 120 },
      { field: "updatedAt", headerName: "Updated", valueFormatter: (p) => shortTime(p.value), flex: 1, minWidth: 120, sort: "desc" },
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
      { field: "resourceStatus", headerName: "Resource status", cellRenderer: statusCell, width: 150 },
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
      overlayNoRowsTemplate: overlay(totalRows === 0 ? EMPTY[tab] : "Nothing matches this view. Pick another status above."),
      domLayout: "autoHeight" as const,
      pagination: true,
      paginationPageSize: 10,
      paginationPageSizeSelector: [10, 25, 50],
      suppressCellFocus: true,
      loading: !loaded,
    };
    switch (tab) {
      case "incidents":
        return (
          <AgGridReact<Incident>
            {...shared}
            rowData={shownIncidents}
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
            rowData={shownTransactions}
            columnDefs={transactionCols}
            getRowId={(p) => p.data.orderId}
            getRowStyle={transactionRowStyle}
            onRowClicked={(e: RowClickedEvent<Transaction>) => e.data && setSelectedOrder(e.data.orderId)}
          />
        );
      case "events":
        return <AgGridReact<EventRow> {...shared} rowData={shownEvents} columnDefs={eventCols} getRowId={(p) => p.data.eventId} />;
      case "actions":
        return (
          <AgGridReact<RecoveryAction>
            {...shared}
            rowData={shownActions}
            columnDefs={actionCols}
            getRowId={(p) => p.data.id}
            onRowClicked={(e: RowClickedEvent<RecoveryAction>) => e.data && setSelectedIncident(e.data.incidentId)}
          />
        );
    }
  })();

  const selectedTx = transactions.find((t) => t.orderId === selectedOrder) ?? null;

  const navItems: { key: Tab; label: string; icon: "incidents" | "transactions" | "events" | "actions"; count: number; alert?: boolean }[] = [
    { key: "incidents", label: "Incidents", icon: "incidents", count: openIncidents.length, alert: openIncidents.length > 0 },
    { key: "transactions", label: "Transactions", icon: "transactions", count: transactions.length },
    { key: "events", label: "Webhook events", icon: "events", count: events.length },
    { key: "actions", label: "Recovery actions", icon: "actions", count: pendingApproval },
  ];
  const section = SECTIONS[tab];

  const reconcileAll = () =>
    run("reconcile", async () => {
      const r = await api.reconcileAll();
      const failed = r.errors.length ? `, ${r.errors.length} could not be checked` : "";
      setNotice({ kind: r.errors.length ? "error" : "ok", text: `Checked ${r.reconciled} orders against PayPal: ${r.inSync} in sync${failed}` });
    });

  const connections: [string, string, boolean | null][] = [
    ["PayPal", config?.paypalClientId ? "Sandbox" : "Not configured", !!config?.paypalClientId],
    ["Webhooks", verifiedEvents ? `${verifiedEvents} verified` : "No events yet", verifiedEvents > 0 ? true : null],
    ["AI", config?.aiProvider === "anthropic" ? "Claude" : config?.aiProvider === "openai" ? "OpenAI" : "Not configured", !!config?.aiProvider],
    ["Approvals", config?.passcodeRequired ? "Passcode on" : "Open", !!config?.passcodeRequired],
  ];

  return (
    <div className="flex min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-zinc-200 bg-white lg:flex dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex h-14 items-center gap-2.5 border-b border-zinc-200 px-4 dark:border-zinc-800">
          <Logo />
          <div className="leading-tight">
            <div className="text-[14px] font-semibold tracking-tight">PayTrace</div>
            <div className="text-[11px] text-zinc-500">Payment operations</div>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-4" aria-label="Sections">
          <div className="px-2 pb-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-zinc-400">Operations</div>
          {navItems.map((item) => (
            <button
              key={item.key}
              onClick={() => setTab(item.key)}
              aria-current={tab === item.key ? "page" : undefined}
              className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition-colors ${
                tab === item.key
                  ? "bg-zinc-100 font-medium text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                  : "text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/50 dark:hover:text-zinc-100"
              }`}
            >
              <Icon name={item.icon} className="size-4 shrink-0 opacity-80" />
              <span className="flex-1 text-left">{item.label}</span>
              {item.count > 0 && (
                <span
                  className={`min-w-5 rounded px-1 text-center text-[11px] font-medium tabular-nums ${
                    item.alert ? "bg-red-600 text-white" : "text-zinc-500"
                  }`}
                >
                  {item.count}
                </span>
              )}
            </button>
          ))}

          <div className="mt-6 px-2 pb-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-zinc-400">Sandbox</div>
          <button
            onClick={() => setCheckoutOpen(true)}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/50 dark:hover:text-zinc-100"
          >
            <Icon name="plus" className="size-4 shrink-0 opacity-80" />
            New test payment
          </button>
        </nav>

        <div className="border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div className="pb-2 text-[11px] font-medium uppercase tracking-[0.06em] text-zinc-400">Connections</div>
          <dl className="space-y-1.5 text-xs">
            {connections.map(([name, value, ok]) => (
              <div key={name} className="flex items-center justify-between gap-2">
                <dt className="text-zinc-500">{name}</dt>
                <dd className="flex items-center gap-1.5 text-zinc-700 dark:text-zinc-300">
                  <span className={`size-1.5 rounded-full ${ok === true ? "bg-emerald-500" : ok === false ? "bg-amber-500" : "bg-zinc-300 dark:bg-zinc-600"}`} />
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          <div className="mt-3 flex items-center justify-between">
            <span className="text-xs text-zinc-500">Theme</span>
            <ThemeToggle value={themePreference} onChange={(v: ThemePreference) => setThemePreference(v)} />
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-14 items-center justify-between gap-3 border-b border-zinc-200 bg-white/90 px-4 backdrop-blur sm:px-6 2xl:px-10 dark:border-zinc-800 dark:bg-zinc-900/90">
          <div className="flex min-w-0 items-center gap-3">
            <div className="lg:hidden">
              <Logo />
            </div>
            <div className="truncate text-[13px]">
              <span className="text-zinc-500">Operations</span>
              <span className="mx-1.5 text-zinc-300 dark:text-zinc-600">/</span>
              <span className="font-medium">{section.title}</span>
            </div>
            <Tag tone="amber">Sandbox</Tag>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden items-center gap-1.5 text-xs text-zinc-500 xl:inline-flex">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              {secondsSinceRefresh === null ? "Connecting" : `Updated ${secondsSinceRefresh}s ago`}
            </span>
            <IdentityMenu
              actor={actor}
              onActorChange={setActor}
              passcodeRequired={!!config?.passcodeRequired}
              passcode={passcode}
              onPasscodeChange={updatePasscode}
            />
            <button onClick={reconcileAll} disabled={busy !== null} className={button.primary}>
              <Icon name="refresh" className={`size-3.5 ${busy === "reconcile" ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline">{busy === "reconcile" ? "Reconciling" : "Reconcile all"}</span>
            </button>
          </div>
        </header>

        <main className="flex flex-col gap-6 px-4 py-6 sm:px-6 2xl:px-10">
          <section className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-zinc-200 bg-zinc-200 sm:grid-cols-3 xl:grid-cols-5 dark:border-zinc-800 dark:bg-zinc-800">
            <Stat
              loading={!loaded}
              label="Open incidents"
              value={openIncidents.length}
              sub={criticalOpen ? `${criticalOpen} critical` : "None critical"}
              alert={openIncidents.length > 0}
              onClick={() => showView("incidents", "open")}
            />
            <Stat
              loading={!loaded}
              label="Money at risk"
              value={atRisk.length ? formatAmount(atRisk[0][0], atRisk[0][1]) : formatAmount("USD", 0)}
              sub={atRisk.length > 1 ? `+ ${atRisk.slice(1).map(([c, v]) => formatAmount(c, v)).join(", ")}` : "Across open incidents"}
              alert={atRisk.length > 0}
            />
            <Stat loading={!loaded} label="Awaiting approval" value={pendingApproval} sub="Proposed recovery actions" onClick={() => showView("actions", "proposed")} />
            <Stat
              loading={!loaded}
              label="In sync with PayPal"
              value={checked.length ? `${checked.length - mismatched} / ${checked.length}` : "-"}
              sub={mismatched ? `${mismatched} out of sync` : checked.length ? "All orders match" : "Not reconciled yet"}
              alert={mismatched > 0}
              meter={checked.length ? { ratio: (checked.length - mismatched) / checked.length, tone: mismatched ? "red" : "green" } : undefined}
              onClick={() => showView("transactions", mismatched ? "mismatch" : "all")}
            />
            <Stat
              loading={!loaded}
              label="Webhook events"
              value={events.length}
              sub={`${failedEvents} failed, ${duplicateDeliveries} duplicates absorbed`}
              meter={events.length ? { ratio: verifiedEvents / events.length, tone: "green" } : undefined}
              onClick={() => showView("events", failedEvents ? "failed" : "all")}
            />
          </section>

          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h1 className="text-[17px] font-semibold tracking-tight">{section.title}</h1>
                <p className="mt-0.5 text-[13px] text-zinc-500">{section.description}</p>
              </div>
              {tab === "transactions" && (
                <button onClick={() => setCheckoutOpen(true)} className={button.secondary}>
                  <Icon name="plus" className="size-3.5" /> Test payment
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Filter by status">
                {viewChips.map((chip) => {
                  const active = views[tab] === chip.key;
                  return (
                    <button
                      key={chip.key}
                      role="tab"
                      aria-selected={active}
                      onClick={() => setViews((v) => ({ ...v, [tab]: chip.key }))}
                      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px] transition-colors ${
                        active
                          ? "bg-zinc-900 font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
                          : "text-zinc-600 hover:bg-zinc-200/60 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                      }`}
                    >
                      {chip.label}
                      <span
                        className={`text-xs tabular-nums ${
                          active ? "opacity-70" : chip.attention && chip.count > 0 ? "font-semibold text-red-600 dark:text-red-400" : "text-zinc-400"
                        }`}
                      >
                        {chip.count}
                      </span>
                    </button>
                  );
                })}
              </div>
              <label className="relative">
                <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-zinc-400" />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter by order, capture or event"
                  aria-label="Filter rows"
                  className={`${input} w-64 pl-8`}
                />
              </label>
            </div>

            <nav className="flex gap-1 overflow-x-auto lg:hidden" aria-label="Sections">
              {navItems.map((item) => (
                <button
                  key={item.key}
                  onClick={() => setTab(item.key)}
                  className={`whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] ${
                    tab === item.key ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "text-zinc-600 dark:text-zinc-400"
                  }`}
                >
                  {item.label} <span className="tabular-nums opacity-70">{item.count}</span>
                </button>
              ))}
            </nav>

            <div className="flex items-start gap-6">
              <div className="min-w-0 flex-1 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
                {/* keyed per tab: each view gets its own grid instance, otherwise column state leaks between tabs */}
                <div key={tab}>{grid}</div>
              </div>

              <aside className="hidden w-72 shrink-0 2xl:block" aria-label="Recent activity">
                <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
                  <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
                    <h2 className="text-[13px] font-semibold">Activity</h2>
                    <span className="text-xs text-zinc-500">Latest {activity.length}</span>
                  </div>
                  {activity.length === 0 ? (
                    <p className="px-4 py-6 text-[13px] text-zinc-500">Nothing yet. Payments, incidents and approvals show up here.</p>
                  ) : (
                    <ol className="divide-y divide-zinc-100 dark:divide-zinc-800">
                      {activity.map((item) => (
                        <li key={item.key}>
                          <button
                            onClick={() => item.incidentId && setSelectedIncident(item.incidentId)}
                            disabled={!item.incidentId}
                            className="flex w-full gap-3 px-4 py-2.5 text-left transition-colors enabled:hover:bg-zinc-50 dark:enabled:hover:bg-zinc-800/50"
                          >
                            <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${ACTIVITY_DOT[item.tone]}`} />
                            <span className="min-w-0 flex-1">
                              <span className="block text-[13px] leading-snug text-zinc-800 dark:text-zinc-200">{item.title}</span>
                              <span className="mt-0.5 block truncate text-xs text-zinc-500">{item.detail}</span>
                            </span>
                            <time className="shrink-0 text-xs tabular-nums text-zinc-400" dateTime={item.at} title={new Date(item.at).toLocaleString()}>
                              {relativeTime(item.at)}
                            </time>
                          </button>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              </aside>
            </div>
          </section>
        </main>
      </div>

      {checkoutOpen && (
        <Modal
          title="New test payment"
          description="Pays a sandbox order with a PayPal test buyer account. Nothing real is charged."
          onClose={() => setCheckoutOpen(false)}
        >
          <div className="flex items-center gap-2">
            <input
              value={newOrder.amount}
              onChange={(e) => setNewOrder({ ...newOrder, amount: e.target.value })}
              aria-label="Amount"
              className={`${input} w-28 tabular-nums`}
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
          </div>
          {config?.paypalClientId && /^\d+(\.\d{1,2})?$/.test(newOrder.amount) ? (
            <div className="mt-4">
              <PayPalCheckout
                clientId={config.paypalClientId}
                amount={newOrder.amount}
                currency={newOrder.currency}
                onCaptured={(orderId, status) => {
                  setCheckoutOpen(false);
                  setTab("transactions");
                  setNotice({ kind: "ok", text: `Paid with PayPal: order ${orderId}, capture ${status ?? "submitted"}` });
                  void refresh();
                }}
                onError={(message) => setNotice({ kind: "error", text: message })}
              />
            </div>
          ) : (
            <p className="mt-4 text-xs text-zinc-500">Enter an amount like 10.00 to load the PayPal button.</p>
          )}
          <div className="mt-4 flex items-center gap-3 border-t border-zinc-200 pt-4 text-xs text-zinc-500 dark:border-zinc-800">
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
            {approveUrl ? (
              <a href={approveUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-sky-700 hover:underline dark:text-sky-400">
                Open approval page
              </a>
            ) : (
              <span>Leaves it unpaid, for testing approval and capture separately.</span>
            )}
          </div>
        </Modal>
      )}

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
