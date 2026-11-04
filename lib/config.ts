// Demo tools (forcing a local status to stage an incident) are always on locally.
// On a deployed demo they stay off unless PAYTRACE_DEMO_MODE=true.
export function demoToolsEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.PAYTRACE_DEMO_MODE === "true";
}

// When set, approving/executing actions, staging and AI runs need this passcode.
// Meant for a public demo URL, not a replacement for real auth.
export function approverPasscode(): string | null {
  return process.env.PAYTRACE_APPROVER_PASSCODE || null;
}
