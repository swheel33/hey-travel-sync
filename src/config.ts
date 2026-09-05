import { existsSync, readFileSync } from "node:fs";

export interface Config {
  databasePath: string;
  watchDebounceSeconds: number;
  dailyReconcileAt: string;
  sourceBoxes: string[];
  travelLabel: string;
  calendarId?: number;
  defaultTimezone: string;
  applyChanges: boolean;
  heyCommand: string;
  opencodeCommand: string;
  model: string;
  workPath: string;
}

const defaults: Config = {
  databasePath: "/data/watch-state.sqlite3",
  watchDebounceSeconds: 30,
  dailyReconcileAt: "03:00",
  sourceBoxes: ["Imbox", "Paper Trail"],
  travelLabel: "Travel",
  defaultTimezone: "UTC",
  applyChanges: false,
  heyCommand: "hey",
  opencodeCommand: "opencode",
  model: "openai/gpt-5.6-luna",
  workPath: "/tmp/hey-travel-sync",
};

const fields = {
  database_path: "databasePath",
  watch_debounce_seconds: "watchDebounceSeconds",
  daily_reconcile_at: "dailyReconcileAt",
  source_boxes: "sourceBoxes",
  travel_label: "travelLabel",
  calendar_id: "calendarId",
  default_timezone: "defaultTimezone",
  apply_changes: "applyChanges",
  hey_command: "heyCommand",
  opencode_command: "opencodeCommand",
  model: "model",
  work_path: "workPath",
} as const;

export function loadConfig(path?: string): Config {
  const environmentPath = process.env.HEY_TRAVEL_CONFIG;
  const selectedPath = path || environmentPath || "/config/config.toml";
  if ((path || environmentPath) && !existsSync(selectedPath)) {
    throw new Error(`config file not found: ${selectedPath}`);
  }
  const values = (existsSync(selectedPath) ? Bun.TOML.parse(readFileSync(selectedPath, "utf8")) : {}) as Record<string, unknown>;
  for (const [toml, property] of Object.entries(fields)) {
    const environment = process.env[`HEY_TRAVEL_${toml.toUpperCase()}`];
    if (environment !== undefined) values[toml] = environment;
    if (values[toml] !== undefined) (values as Record<string, unknown>)[property] = values[toml];
  }
  const config = { ...defaults, ...pickConfig(values) };
  config.watchDebounceSeconds = integer(config.watchDebounceSeconds, "watch_debounce_seconds");
  if (config.calendarId !== undefined && config.calendarId !== null && String(config.calendarId) !== "") {
    config.calendarId = integer(config.calendarId, "calendar_id");
  } else delete config.calendarId;
  config.applyChanges = boolean(config.applyChanges);
  config.sourceBoxes = strings(config.sourceBoxes, "source_boxes");
  if (!config.sourceBoxes.length) throw new Error("source_boxes must contain at least one box");
  if (config.watchDebounceSeconds < 0 || config.watchDebounceSeconds > 3600) {
    throw new Error("watch_debounce_seconds must be between 0 and 3600");
  }
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(config.dailyReconcileAt)) {
    throw new Error("daily_reconcile_at must be HH:MM in 24-hour time");
  }
  assertTimezone(config.defaultTimezone);
  return config;
}

export function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new Error(`unknown IANA timezone: ${timezone}`);
  }
}

function pickConfig(values: Record<string, unknown>): Partial<Config> {
  const output: Record<string, unknown> = {};
  for (const property of Object.values(fields)) if (values[property] !== undefined) output[property] = values[property];
  return output as Partial<Config>;
}

function integer(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function boolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function strings(value: unknown, name: string): string[] {
  const values = Array.isArray(value) ? value : String(value).split(",");
  const normalized = values.map((item) => String(item).trim()).filter(Boolean);
  if (normalized.length !== values.length) throw new Error(`${name} cannot contain empty values`);
  return [...new Set(normalized)];
}
