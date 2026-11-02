import type { Metadata } from "next";
import Dashboard from "./dashboard";

export const metadata: Metadata = {
  title: "PayTrace AI Dashboard",
  description: "Payment observability and recovery for PayPal",
};

export default function DashboardPage() {
  return <Dashboard />;
}
