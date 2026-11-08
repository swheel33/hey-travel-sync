import { Database } from "bun:sqlite";
import { loadConfig } from "./config.ts";
import { Extractor } from "./extract.ts";
import { Hey } from "./hey.ts";
import { reservationKey } from "./reservation.ts";
import { Store } from "./store.ts";
import { Sync, type Summary } from "./sync.ts";

const usage = `Usage: hey-travel-sync <command>

  run                          Poll HEY and sync the calendar until stopped (the container default)
  sync [--dry-run] [--all] [--since-days N] [--thread ID]
                               One pass; --all reads every page, --thread forces one thread
  status                       Show failed threads and the events this app manages
  doctor                       Check HEY and Claude access
  import-legacy PATH           Adopt events created by the old OpenCode release from its SQLite file`;

const args = process.argv.slice(2);
const command = args[0] ?? "run";
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const config = loadConfig();
const hey = new Hey(config.heyCommand);

switch (command) {
  case "run": {
    const sync = new Sync(config, hey, new Extractor(config.model), new Store(config.databasePath));
    let stopping = false;
    let wake = () => {};
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { stopping = true; wake(); });
    console.log(`polling ${config.boxes.join(", ")} every ${config.pollMinutes}m with ${config.model}`);
    while (!stopping) {
      try {
        report(await sync.run({ apply: true }));
      } catch (error) {
        console.error("pass failed:", error instanceof Error ? error.message : error);
      }
      await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, config.pollMinutes * 60_000); });
    }
    break;
  }
  case "sync": {
    const topic = option("--thread");
    const since = option("--since-days");
    const sync = new Sync(config, hey, new Extractor(config.model), new Store(config.databasePath));
    report(await sync.run({
      apply: !flag("--dry-run"), all: flag("--all") || topic !== undefined,
      sinceDays: since ? Number(since) : undefined, topicId: topic ? Number(topic) : undefined,
    }));
    break;
  }
  case "status": {
    const store = new Store(config.databasePath);
    console.log("Failed threads:");
    for (const row of store.failedThreads()) console.log(`  ${row.topic_id} x${row.attempts} "${row.subject}": ${row.error}`);
    console.log("Managed events:");
    for (const row of store.events()) console.log(`  ${row.event_id ?? "UNFINISHED"}  ${row.label}  (${row.key})`);
    break;
  }
  case "doctor": {
    console.log(`hey: ${await hey.version()}`);
    console.log(`label "${config.travelLabel}": ${(await hey.labelId(config.travelLabel)) ?? "missing (threads won't be labelled)"}`);
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const model = await new Anthropic().models.retrieve(config.model);
    console.log(`claude: ${model.id} reachable`);
    break;
  }
  case "import-legacy": {
    const path = args[1];
    if (!path) throw new Error(usage);
    const legacy = new Database(path, { readonly: true });
    const store = new Store(config.databasePath);
    const rows = legacy.query<{ normalized_json: string; source_date: string; event_id: number }, []>(`
      SELECT r.normalized_json, r.source_date, l.event_id FROM event_links l JOIN reservations r ON r.segment_key = l.segment_key WHERE l.owned = 1
    `).all();
    for (const row of rows) {
      const old = JSON.parse(row.normalized_json);
      const key = reservationKey({ ...old, number: old.segment });
      const label = [old.provider, old.segment, old.confirmation].filter(Boolean).join(" ");
      if (store.event(key)) continue;
      // An empty hash makes the next extraction of that booking rewrite the event in the new format.
      store.saveEvent(key, row.event_id, "", row.source_date, label);
      console.log(`adopted event ${row.event_id}: ${label}`);
    }
    break;
  }
  default:
    console.error(usage);
    process.exit(2);
}

function report(summary: Summary): void {
  console.log(JSON.stringify(summary));
}
