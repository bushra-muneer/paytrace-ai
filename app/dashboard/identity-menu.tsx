"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Icon, input } from "./ui";

const DEFAULT_PEOPLE = ["Operator", "Reviewer"];
const PEOPLE_KEY = "paytrace.people";

function readPeople(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(PEOPLE_KEY) ?? "null");
    return Array.isArray(saved) && saved.length ? saved : DEFAULT_PEOPLE;
  } catch {
    return DEFAULT_PEOPLE;
  }
}

function savePeople(people: string[]) {
  try {
    localStorage.setItem(PEOPLE_KEY, JSON.stringify(people));
  } catch {
    /* storage unavailable */
  }
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

type CheckState = "idle" | "checking" | "ok" | "wrong";

export function IdentityMenu({
  actor,
  onActorChange,
  passcodeRequired,
  passcode,
  onPasscodeChange,
}: {
  actor: string;
  onActorChange: (name: string) => void;
  passcodeRequired: boolean;
  passcode: string;
  onPasscodeChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [people, setPeople] = useState<string[]>(DEFAULT_PEOPLE);
  const [newName, setNewName] = useState("");
  const [showPasscode, setShowPasscode] = useState(false);
  const [check, setCheck] = useState<CheckState>("idle");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time restore from storage
    setPeople(readPeople());
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const addPerson = () => {
    const name = newName.trim();
    if (!name) return;
    const next = people.includes(name) ? people : [...people, name];
    setPeople(next);
    savePeople(next);
    onActorChange(name);
    setNewName("");
  };

  const removePerson = (name: string) => {
    const next = people.filter((p) => p !== name);
    setPeople(next.length ? next : DEFAULT_PEOPLE);
    savePeople(next.length ? next : DEFAULT_PEOPLE);
    if (actor === name) onActorChange("");
  };

  const verify = useCallback(async () => {
    setCheck("checking");
    try {
      await api.checkPasscode();
      setCheck("ok");
    } catch {
      setCheck("wrong");
    }
  }, []);

  // a restored passcode is checked once, so the lock shows the real state; never while typing
  const autoChecked = useRef(false);
  useEffect(() => {
    if (open || autoChecked.current || !passcodeRequired || !passcode) return;
    autoChecked.current = true;
    void verify();
  }, [open, passcodeRequired, passcode, verify]);

  const locked = passcodeRequired && check !== "ok";
  // a name typed before the list existed should still show up
  const list = actor && !people.includes(actor) ? [actor, ...people] : people;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex h-8 items-center gap-2 rounded-md border border-zinc-300 bg-white pl-1 pr-2 text-[13px] transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
      >
        <span
          className={`flex size-6 items-center justify-center rounded text-[11px] font-semibold ${
            actor ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
          }`}
        >
          {actor ? initials(actor) : "?"}
        </span>
        <span className={`hidden max-w-36 truncate sm:inline ${actor ? "font-medium" : "text-amber-700 dark:text-amber-400"}`}>
          {actor || "Choose who you're acting as"}
        </span>
        {passcodeRequired && <Icon name="lock" className={`size-3.5 ${locked ? "text-zinc-400" : "text-emerald-600"}`} />}
        <svg viewBox="0 0 24 24" className="size-3.5 text-zinc-400" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Identity and approvals"
          className="animate-fade-in absolute right-0 top-10 z-50 w-80 rounded-lg border border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
        >
          <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
            <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-zinc-400">Acting as</div>
            <ul className="mt-2 space-y-0.5">
              {list.map((name) => (
                <li key={name} className="group flex items-center">
                  <button
                    onClick={() => onActorChange(name)}
                    className={`flex flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors ${
                      actor === name ? "bg-zinc-100 font-medium dark:bg-zinc-800" : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                    }`}
                  >
                    <span className="flex size-5 items-center justify-center rounded bg-zinc-200 text-[10px] font-semibold text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">
                      {initials(name)}
                    </span>
                    <span className="flex-1 truncate">{name}</span>
                    {actor === name && <Icon name="check" className="size-3.5 text-emerald-600" />}
                  </button>
                  <button
                    onClick={() => removePerson(name)}
                    aria-label={`Remove ${name}`}
                    className="ml-1 rounded p-1 text-zinc-400 opacity-0 transition-opacity hover:text-zinc-700 group-hover:opacity-100 dark:hover:text-zinc-200"
                  >
                    <Icon name="close" className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
            <form
              className="mt-2 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                addPerson();
              }}
            >
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Add a name"
                aria-label="Add a name"
                className={`${input} min-w-0 flex-1`}
              />
              <button type="submit" disabled={!newName.trim()} className="rounded-md border border-zinc-300 px-2.5 text-[13px] font-medium disabled:opacity-40 dark:border-zinc-700">
                Add
              </button>
            </form>
            <p className="mt-2 text-xs leading-relaxed text-zinc-500">
              Approvals must come from a different person than the one who proposed the action.
            </p>
          </div>

          {passcodeRequired && (
            <div className="px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-zinc-400">Approver passcode</span>
                {check === "ok" && <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">Accepted</span>}
                {check === "wrong" && <span className="text-xs font-medium text-red-700 dark:text-red-400">Incorrect</span>}
              </div>
              <div className="mt-2 flex gap-2">
                <div className="relative min-w-0 flex-1">
                  <input
                    type={showPasscode ? "text" : "password"}
                    value={passcode}
                    onChange={(e) => {
                      onPasscodeChange(e.target.value);
                      setCheck("idle");
                    }}
                    onKeyDown={(e) => e.key === "Enter" && passcode && void verify()}
                    placeholder="Required to approve or run AI"
                    aria-label="Approver passcode"
                    autoComplete="current-password"
                    className={`${input} w-full pr-14`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPasscode((s) => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-medium text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                  >
                    {showPasscode ? "Hide" : "Show"}
                  </button>
                </div>
                <button
                  onClick={() => void verify()}
                  disabled={!passcode || check === "checking"}
                  className="rounded-md bg-zinc-900 px-3 text-[13px] font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
                >
                  {check === "checking" ? "..." : "Check"}
                </button>
              </div>
              <p className="mt-2 text-xs text-zinc-500">Kept for this browser tab only.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
