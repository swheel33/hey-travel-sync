# HEY Travel Sync

Reads reservation mail from HEY and keeps HEY Calendar events for flights, trains, buses, hotel
stays, and restaurant bookings.

## How it works

Every `POLL_MINUTES` (default 5) the container:

1. Lists the newest 50 threads in each box in `HEY_BOXES` (default `Imbox`, `Paper Trail`).
2. Skips threads it has already handled at the same revision, and scores the rest on subject,
   preview, and sender (`src/filter.ts`). Routine mail never reaches the model. A thread that
   has produced travel before is always re-read, so follow-ups such as cancellations are seen.
3. Reads the thread and its attachments with the `hey` CLI and sends them to Claude in one
   Messages API call with a JSON schema (`src/extract.ts`), using Claude Haiku 5.5 at low effort
   by default (`CLAUDE_MODEL`, `CLAUDE_EFFORT`). The model has no tools.
4. Validates each reservation, renders its event (`src/reservation.ts`), and creates, updates,
   or deletes events recorded in SQLite (`src/store.ts`). It only touches events it created.

A failed thread is retried with an hourly backoff, up to three times per revision. `status` lists
failures.

## Time zones

The model copies every time as printed, local to its place, and names the IANA zone of each
end (LGA → `America/New_York`, ORD → `America/Chicago`). The code turns those into instants;
the model never does offset arithmetic.

A HEY event carries a single zone, so a transport event sits in the departure zone at the
correct instants. When the arrival zone differs, the title ends with the local arrival time (and its date when it differs),
for example `SQ023 JFK → SIN (arr Fri Dec 18, 6:00 AM local)`, and the notes give both local times. Hotel
stays are all-day events from check-in to check-out.

## Safety

- Email is untrusted. The prompt says so, the model has no tools, and output must match a schema.
- A cancellation deletes an event only when the email literally says "cancel" and the confirmation
  matches an event this app created.
- Reminders without times, and stays without a check-out, are skipped rather than guessed.
- A thread whose body comes back empty fails loudly. That is how the old HEY CLI 1.4 broke:
  it rendered whole emails as `📎 attachment`.
- An event row with no ID means a create was interrupted. `status` shows it as `UNFINISHED`;
  check HEY Calendar for a stray event, then delete the row.

## Setup

```sh
cp .env.example .env              # set ANTHROPIC_API_KEY
docker compose build
docker compose run --rm --entrypoint hey sync auth login --no-browser   # first time only
docker compose run --rm sync doctor
docker compose run --rm sync sync --dry-run --all --since-days 90
docker compose up -d
```

HEY credentials live in the `/data` volume. Other commands:

```sh
docker compose run --rm sync sync --dry-run --thread 2179079110   # debug one thread
docker compose run --rm sync status
```

## Moving from the OpenCode release

The old release kept its state in `/data/watch-state.sqlite3`. Adopt the events it created so they
are updated rather than duplicated, then backfill:

```sh
docker compose run --rm sync import-legacy /data/watch-state.sqlite3
docker compose run --rm sync sync --all --since-days 120
```

## Development

```sh
bun install
bun test
bun run typecheck
```
