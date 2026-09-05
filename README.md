# HEY Travel Sync

HEY Travel Sync reads reservation mail from configured HEY boxes and reconciles
application-owned HEY Calendar events. The default sources are `Imbox` and `Paper Trail`.
Calendar writes are disabled by default.

## Architecture

1. HEY posting subject, summary, sender, and attachment/calendar indicators are scored locally
   using travel, reservation, provider, disruption, structure, and marketing signals. Forwarding
   is not a signal. Non-candidates are counted as `filtered`; their threads are not downloaded and
   no model is called. Updates to previously extracted topics bypass this filter.
2. Candidate threads are fetched as HEY JSON. Their Markdown bodies are assembled oldest first
   with sender, date, and entry ID metadata, and attachments are downloaded.
3. OpenCode runs an isolated, invocation-only `travel-extractor` agent with
   `openai/gpt-5.6-luna`. The agent has no tool, filesystem, or network permissions and receives
   only files attached by the CLI invocation.
4. TypeScript validates exact JSON and derives reservation identity and calendar titles locally.
   SQLite reconciliation limits updates and deletes to events created by this app.
5. `hey watch` supplies posting changes. Changes for one topic are debounced and all work is
   strictly single-flight; resync notifications and the daily wall-clock pass scan all pages.

Supported reservations are flights, trains, buses, lodging, and restaurants. Transport legs
become separate events. Exact duplicate extraction results merge; conflicting results for one
segment fail the thread and are retried on a later pass.

## Privacy

Candidate email Markdown and attachments are sent to the configured OpenCode model provider for
extraction. Mode-`0600` temporary files are removed after the invocation. Raw bodies and
attachments are never stored in the application SQLite database. OpenCode retains its own local
session records under `/data/home/.local/share`; those records can include attached email content
and provide historical token usage. OpenCode session sharing is disabled. The application SQLite
database stores posting revisions, validated extraction results, normalized reservations, and
owned event links. Non-candidate message metadata is examined locally only.

Email and attachments are untrusted input. The extractor prompt tells the model to ignore all
instructions in them, requires exact JSON, and the local validator rejects malformed output,
unknown or extra keys, unsupported kinds/statuses, oversized strings, invalid dates/time zones,
and incomplete reservations. Rejected output is not marked ignored, so it is retried.

## Requirements

- Bun 1.4
- HEY CLI 1.4.0
- OpenCode 1.18.25
- OpenCode authentication for the configured model (default `openai/gpt-5.6-luna`)

## Setup

```sh
bun install --frozen-lockfile
cp config.example.toml config.toml
hey auth login
opencode auth login
bun run src/cli.ts doctor --config config.toml
bun run src/cli.ts sync --dry-run --config config.toml
```

Review dry-run actions before enabling writes. A dry run caches validated extraction, so a later
apply reconciles it without another model call. Sync and watch mode may also use
`apply_changes = true`; explicit `--dry-run` always overrides it.

```sh
bun run src/cli.ts sync --apply --config config.toml
bun run src/cli.ts watch --apply --config config.toml
```

Backfill is dry-run unless `--apply` is explicitly supplied, regardless of configuration:

```sh
bun run src/cli.ts backfill --since-days 90 --dry-run --config config.toml
bun run src/cli.ts backfill --since-days 90 --apply --config config.toml
```

## Cancellation Policy

A model cancellation can delete an event only when all of these conditions hold:

- The raw HEY Markdown contains the explicit word `cancel`, `cancelled`, `canceled`, or
  `cancellation`.
- The extracted cancellation has a non-empty provider and confirmation reference.
- Exactly one event recorded as owned by this application matches kind, provider, and
  confirmation; a supplied flight, train, or bus segment must also match.

Providerless fuzzy deletion is never allowed. An ambiguous cancellation, a cancellation with no
owned match, or one without explicit raw wording remains pending and is retried. Confirmed updates
retain the same ownership and confirmation matching protections. Confirmation-free confirmed
events are create-only.

## Safety

- Created events carry a `hey-travel-sync:v1` ownership note with reservation and segment keys.
- Threads are processed oldest first so later changes win during initial sync and backfill.
- An interrupted pending calendar operation blocks that event scope for manual verification.
- For a pending-operation error, inspect HEY Calendar first. Do not clear the pending row until
  verifying whether the remote create, update, or delete completed; otherwise a retry can create a
  duplicate event. Restore the state database from backup if the local outcome cannot be reconciled.
- Temporary extraction files are removed whether extraction succeeds or fails.
- The watch-driven schema is greenfield. Point `database_path` at a new file when replacing the
  retired polling release. The default is `/data/watch-state.sqlite3`, which leaves the retired
  database and `/data/home` credentials untouched.
- Keep one running replica because SQLite state is stored on one volume.

## Docker

The image pins Bun 1.4.0, HEY 1.4.0, and OpenCode 1.18.25. HEY and OpenCode release artifacts
are checksum-verified during the build. The image has no Qt or KDE extraction dependencies.

```sh
cp config.example.toml config.toml
docker compose build
docker run --rm -it --network host \
  -e HOME=/data/home -e XDG_CONFIG_HOME=/data/home/.config -e XDG_DATA_HOME=/data/home/.local/share \
  -e HEY_NO_KEYRING=1 -v hey-travel-sync_hey-travel-data:/data \
  --entrypoint hey hey-travel-sync:local auth login --no-browser
docker run --rm -it --network host \
  -e HOME=/data/home -e XDG_CONFIG_HOME=/data/home/.config -e XDG_DATA_HOME=/data/home/.local/share \
  -v hey-travel-sync_hey-travel-data:/data \
  --entrypoint opencode hey-travel-sync:local auth login
docker compose run --rm sync doctor
docker compose run --rm sync sync --dry-run
docker compose run --rm sync backfill --since-days 90 --dry-run
docker compose run --rm sync sync --apply
```

`XDG_DATA_HOME` is under the persistent `/data` volume, so OpenCode authentication survives
container replacement. HEY authentication and OpenCode session/token history are persisted there
as well. Do not mount host credential files into the container. Historical model usage is
available with:

```sh
docker compose run --rm --no-deps --entrypoint opencode sync stats --models
```

Ignore OpenCode's subscription cost field when applying public per-token prices. The per-model
output count includes reasoning tokens. After validating one controlled `--apply`, set
`apply_changes = true`, run `docker compose up -d`, and confirm `HEY watch ready` in the logs.

## Limitations

- HEY Calendar applies one timezone to both event boundaries; offset-bearing arrival times are
  converted to the departure timezone.
- A crash after a successful remote create but before its event ID is persisted requires manual
  inspection of ownership notes.
- Normal sync checks the newest 50 threads per source box. Backfill, watch resync, and the daily
  reconciliation request all pages.
