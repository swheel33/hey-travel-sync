#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "./config.ts";
import { Runner } from "./command.ts";
import { StateDatabase } from "./database.ts";
import { HeyClient } from "./hey.ts";
import { OpenCodeExtractor } from "./extractor.ts";
import { SyncService } from "./sync.ts";
import { WatchSupervisor } from "./watch.ts";

const usage = `Usage: hey-travel-sync [--config PATH] <command> [options]

Commands:
  doctor                         Check commands, watch support, authentication, and database
  watch [--apply|--dry-run]      Watch HEY and reconcile continuously
  sync [--apply|--dry-run]       Run one normal reconciliation
  backfill [--since-days N] [--apply|--dry-run]
                                  Process all pages; writes require --apply`;

async function main(arguments_: string[]): Promise<number> {
  if (arguments_.includes("--help") || arguments_.includes("-h")) {
    console.log(usage);
    return 0;
  }
  validateArguments(arguments_);
  const configPath = option(arguments_, "--config");
  const valueIndexes = new Set(["--config", "--since-days"].flatMap((name) => {
    const index = arguments_.indexOf(name);
    return index < 0 ? [] : [index + 1];
  }));
  const command = arguments_.find((item, index) => !item.startsWith("-") && !valueIndexes.has(index));
  if (!command) throw new Error(usage);
  const config = loadConfig(configPath);
  mkdirSync(config.workPath, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(config.databasePath), { recursive: true });
  const database = new StateDatabase(config.databasePath);
  database.migrate();
  const controller = new AbortController();
  const runner = new Runner();
  const hey = new HeyClient(config.heyCommand, runner, controller.signal);
  const service = new SyncService(
    config,
    database,
    hey,
    new OpenCodeExtractor(runner, config.opencodeCommand, config.model, config.workPath, controller.signal),
  );
  const stop = () => controller.abort(new DOMException("Shutdown requested", "AbortError"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let supervisor: WatchSupervisor | undefined;
  try {
    if (command === "doctor") {
      return await doctor(config.databasePath, config.heyCommand, config.opencodeCommand, config.model, hey, runner, controller.signal);
    }
    const explicitApply = arguments_.includes("--apply");
    const dryRun = arguments_.includes("--dry-run");
    if (explicitApply && dryRun) throw new Error("accepts only one of --apply or --dry-run");
    const apply = dryRun ? false : command === "backfill" ? explicitApply : explicitApply || config.applyChanges;
    if (command === "watch") {
      supervisor = new WatchSupervisor(config, database, hey, service, apply, controller.signal);
      await supervisor.run();
      return 0;
    }
    const sinceDays = command === "backfill" ? numberOption(arguments_, "--since-days", 90) : undefined;
    const summary = await service.sync({
      apply, allPages: command === "backfill", sinceDays, signal: controller.signal,
    });
    console.log(JSON.stringify(summary));
    return summary.errors ? 1 : 0;
  } catch (error) {
    if (controller.signal.aborted) return 0;
    throw error;
  } finally {
    controller.abort(new DOMException("Command complete", "AbortError"));
    runner.terminate();
    await supervisor?.shutdown();
    database.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

function validateArguments(arguments_: string[]): void {
  const knownOptions = new Set(["--config", "--apply", "--dry-run", "--since-days"]);
  for (const argument of arguments_) {
    if (argument.startsWith("--") && !knownOptions.has(argument)) throw new Error(`unknown option: ${argument}`);
  }
  const valueIndexes = new Set<number>();
  for (const name of ["--config", "--since-days"]) {
    const index = arguments_.indexOf(name);
    if (index >= 0) valueIndexes.add(index + 1);
  }
  const positionals = arguments_.filter((item, index) => !item.startsWith("-") && !valueIndexes.has(index));
  if (positionals.length !== 1 || !["doctor", "watch", "sync", "backfill"].includes(positionals[0] || "")) throw new Error(usage);
}

async function doctor(
  databasePath: string,
  heyCommand: string,
  opencodeCommand: string,
  model: string,
  hey: HeyClient,
  runner: Runner,
  signal: AbortSignal,
): Promise<number> {
  const checks: Record<string, Record<string, unknown>> = {};
  const commands: Array<[string, string]> = [["hey", heyCommand], ["opencode", opencodeCommand]];
  for (const [name, command] of commands) {
    const path = Bun.which(command);
    if (!path) { checks[name] = { ok: false, error: "not found" }; continue; }
    try {
      checks[name] = { ok: true, path, version: (await runner.run([command, "--version"], 30, signal)).stdout.trim() };
    } catch (error) {
      checks[name] = { ok: false, path, error: error instanceof Error ? error.message : String(error) };
    }
  }
  try {
    await runner.run([heyCommand, "watch", "--help"], 30, signal);
    checks.hey_watch = { ok: true };
  } catch (error) {
    checks.hey_watch = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  try {
    const status = await hey.authStatus();
    checks.hey_auth = { ...status, ok: status.authenticated === true };
  } catch (error) {
    checks.hey_auth = { ok: false, authenticated: false, error: error instanceof Error ? error.message : String(error) };
  }
  const provider = model.split("/", 1)[0] || "";
  try {
    const auth = await runner.run([opencodeCommand, "auth", "list", "--pure"], 30, signal);
    const authenticated = Boolean(provider && auth.stdout.toLowerCase().includes(provider.toLowerCase()));
    checks.opencode_auth = authenticated
      ? { ok: true, provider }
      : { ok: false, provider, error: "configured model provider is not authenticated" };
  } catch (error) {
    checks.opencode_auth = { ok: false, provider, error: error instanceof Error ? error.message : String(error) };
  }
  checks.database = { ok: true, path: databasePath };
  console.log(JSON.stringify(checks, null, 2));
  return Object.values(checks).every((check) => check.ok) ? 0 : 1;
}

function option(arguments_: string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  if (index < 0) return undefined;
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function numberOption(arguments_: string[], name: string, fallback: number): number {
  const value = option(arguments_, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
