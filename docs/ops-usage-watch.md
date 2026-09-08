# Free-Tier Usage Watch — Neon + Render

**STATUS: BUILT AND LIVE.** The GitHub Actions cron is the runner; all four repo
secrets are set and a full run is green end to end (2026-09-01).

Daily pull of real consumption from both providers, projected against the billing
cycle, alerting to Discord only when the *pace* is bad.

```bash
npm run ops:usage
```

---

## 1. Why this exists

August 2026 blew the free-plan allowances on both services. The Neon half is on
record with an exact shape:

> egress is `boot payload × world loads per day`. The July work cut the second
> factor; **nothing was watching the first**, and the deploy workflow's header
> still said "~4.7MB" months after it was ~30MB.

So this is not a dashboard. It is the thing that was missing: something that
watches the first factor, and says so before the cap is hit rather than after.

---

## 2. Pace, not total

"You have used 4.1 of 5 GB" arrives too late to act on. Every cycle metric is
therefore projected:

```
elapsed   = (now − period_start) / (period_end − period_start)
projected = used / elapsed
band      = projected / limit
```

| Band | Ratio | Meaning |
|---|---|---|
| 🟢 OK | < 0.80 | On pace. |
| 🟡 WATCH | 0.80–1.00 | Would finish the cycle near the cap. |
| 🟠 ALERT | 1.00–1.30 | Will exceed unless something changes. |
| 🔴 CRITICAL | > 1.30, or already over | Act now. |

**Two guards, because a naive projection is noise.**

- **Warm-up.** An hour into a cycle, 1 GB projects to 700 GB. Days 1–3 are
  suppressed unless absolute usage has already passed a quarter of the
  allowance. The table prints `too early` rather than the absurd number — a
  huge projection beside a green light trains you to distrust the colour.
- **Acceleration.** A flat 0.9 all month is fine; 0.5 → 0.9 over a week is
  August happening again. Both read as "0.9" to a snapshot, so the `7d` column
  compares against the run from a week ago.

**Standing caps** (storage, branch count) are not projected — they are not
consumed over a cycle, so the ratio *is* the answer.

---

## 3. Limits, and why they carry dates

[`scripts/ops/limits.js`](../scripts/ops/limits.js) — every ceiling names the page
it came from and the day it was read, and the report nags when a row passes 90
days. Both providers move their plans (Render restructured on 2026-04-23 and
third-party summaries still disagree about free bandwidth), and a number with no
provenance is a rumour that fails silently: the report keeps printing confident
percentages against a ceiling that moved.

**To re-verify:** open `source`, read the number, update `value` and `checkedOn`
*together*. Bumping the date without opening the page is how this decays back
into folklore.

| Key | Free ceiling | Notes |
|---|---|---|
| `neon.transfer` | 5 GB/cycle | **Account-wide**, pooled across all projects. |
| `neon.compute` | 100 CU-hours/cycle | |
| `neon.storage` | 0.5 GB | Standing cap. |
| `neon.branches` | 10 | Standing cap. Deploy risk, not billing — see §6. |
| `render.bandwidth` | 100 GB/cycle | ⚠ marked `unverified`. |
| `render.instanceHours` | 750/cycle | Not exposed by the API — see §5. |
| `render.buildMinutes` | 500/cycle | **Derived**, not measured — see §5. |

### We grade against FREE even though Neon is on Launch

The Neon project reports `subscription_type: launch_v3` (owner
davidjohnlacey@gmail.com) — a metered pay-as-you-go plan, not Free. Grading
against Launch's much larger allowances would print a comfortable green while
the free-plan budget is being blown, which is exactly the question being asked.
So everything is graded against **free** ceilings, and the live plan is printed
on its own line so the drift stays visible.

---

## 4. Attribution — the half that says what to change

A percentage does not tell you what to do, so the report also measures both
factors of the egress model directly, from **production**:

- **Boot payload** — `sum(pg_column_size(t.*))` over every table declaring
  `readTier: 'boot'` in [`content-registry.js`](../server/models/content-registry.js),
  **minus the ones marked `bootSource: 'files'`**. One `UNION ALL`, not one query
  per table.

  ⚠ **`readTier: 'boot'` means "in memory at boot", not "fetched from Neon at
  boot", and for months this counted the difference.** The six audio tables are
  both — and in production `loadAudioLibrary` reads them off the checkout, so
  they cost nothing. Summing them anyway put **14.2 MB** of untouchable audio at
  the top of the printout, 11.5 MB of it `audio_samples.data`, a column no boot
  read selects in any environment. That was about **half** the modelled payload,
  and it landed on the divergence check below, which is the one thing here that
  cannot afford a constant offset. Corrected 2026-09-02: real cold-start payload
  is ~13.7 MB, `zones` is 63% of it, and the report now names what it left out.
- **World loads/day** — cold starts from **Render's CPU timeline** (§5).

⚠ **Not from `player_count_log`, which undercounts by roughly half.** That was
the original source and it is wrong: the log is written by `schedule('1m', …)`
in `server/api/routes.js`, and `scheduler.js` **idle-gates every callback by
default**, so logging simply stops when nobody is online. Its gaps mean "down
OR up-but-empty", indistinguishable, and an idle stretch either side of a
restart merges into a single gap. Measured 2026-09-01: Render said **13.4
cold starts/day**, `player_count_log` said **6.8** — and the low figure is the
dangerous direction for a budget alarm. It survives only as a fallback for when
Render is unreachable, and the report labels which source it used.

**The divergence is the point.** If model ≈ API, world boot is the budget and the
payload is the lever. If Neon reports much more, something *else* is leaking and
trimming the payload would be wasted work. Neither number alone tells you that.

⚠ **Attribution owns its own pool, pointed at `PROD_DATABASE_URL`.**
`server/models/db.js` connects to `DATABASE_URL`, which in a dev `.env` is the
*local* database — whose `player_count_log` is empty, so world-loads silently
comes back null and the model evaporates with no error. If `PROD_DATABASE_URL`
is unset the report says so in its notes rather than quietly describing your dev
world.

---

## 4b. The prod egress meter — what a `--prod` script just spent

The report measures the *server's* egress. It says nothing about the other
spender: a developer running a one-shot against production. Every script that
goes through `connectTarget({ prod: true })` in
[`scripts/content/lib.mjs`](../scripts/content/lib.mjs) now prints what it read
on the way out, and appends a JSONL row to `data/ops/prod-reads.log` (gitignored
— it's local evidence, not shared state):

```
prod egress: 588 B over 6 queries, 0.5s — ep-….us-east-1.aws.neon.tech
```

Above 25 MB it says so loudly. Override with `PROD_EGRESS_WARN_MB`, which is
also how you exercise the loud path without spending 25 MB to see it.

**This exists because of 2026-09-07.** Egress ran 89 MB one day and ~600 MB the
next, in a cycle already projected at 190% of the cap. Deploys were 2/day, peak
population was **1**, no scheduled task opts out of the idle gate, and the drift
report has compared inside Postgres since July — so none of the usual suspects
fit. The only surviving trace was `pg_stat_user_tables` on prod, showing
**8,992 seq scans over `zones` for 98,986,080 tuples**, about 5,700 full passes
over a table the server reads once at boot. The scripts that did it had already
been deleted. A number printed at the time would have named the culprit in one
line, and the meter is that line.

⚠ **The count is exact wire bytes** — `socket.bytesRead`, which is what Neon
bills. It isn't an estimate from stringifying result sets: that would cost a full
extra copy of every export and disagree with the invoice. Where the socket isn't
reachable it degrades to a row count and says the byte figure is unavailable,
because a wrong number here is worse than no number.

⚠ **It reports on process exit, not on `client.end()`.** A run that throws half
way through has still spent the egress, and that's the run you most want it for.

### The ad-hoc path, which is the one that matters

`connectTarget` only covers the *pipeline* scripts. The documented one-shot
pattern —

```bash
node --env-file=.env.prod scripts/<name>.mjs
```

— goes through `query()` in [`server/models/db.js`](../server/models/db.js)
instead, and that is the path with no review and no CI behind it. It's also the
shape of what spent the 600 MB. So the pool meters itself too, on the same terms:
exact `socket.bytesRead`, **remote targets only**, one line on exit.

⚠ **It sums across the pool, not one connection.** A pooled client is destroyed
and replaced on idle timeout and its socket's counter dies with it, so a closing
connection banks its total on the way out. Reading only the live sockets would
under-report every long run — the wrong direction for a budget alarm.

Its loud threshold is **100 MB** (`DB_EGRESS_WARN_MB`), not 25: a cold start
legitimately reads ~13.5 MB, and a game server that cried wolf at every shutdown
would train everyone to ignore it.

Calibration, if you want to trust it: 300 `zones` rows measured **172.6 KB**,
which extrapolates to ~9.9 MB for the table — against the 9.83 MB §4 gets from
`pg_column_size`. Two independent methods, agreeing.

### What still isn't covered

`scripts/ops/attribution.mjs` owns its own pool, deliberately unmetered — three
aggregate queries returning ~45 rows, and a meter on it would be ceremony.

`npm run db:backup-prod` shells out to `pg_dump`, so no `pg` client of ours ever
sees those bytes. It now reports its own dump size as egress instead. ⚠ **A full
dump is ~17 MB, not the ~120 MB the storage counter implies** — storage includes
indexes, bloat and WAL; a plain-format dump is data as text. Corrected 2026-09-07,
having made exactly that mistake in this section's first draft.

---

## 5. What the APIs will and won't tell you

**⚠ Neon's `/consumption_history` is a paid endpoint.** The obvious API for this
— the one Neon's own consumption-metrics guide documents — answers 403 on
anything below a Scale plan, with the *same* 403 for every metric name, so it
reads like an auth failure rather than a plan gate. The free-accessible answer is
the **project object**: `GET /projects/{id}` carries the billing-period counters
as plain fields (`data_transfer_bytes`, `compute_time_seconds`,
`synthetic_storage_size`) plus `consumption_period_start`/`_end`. Two cheap
calls, no plan gate, and the cycle boundary is stated rather than guessed.

**⚠ Render's bandwidth series is in megabytes, not bytes.** Each series carries
its own `unit` field (observed: `"mb"`). Summing the raw numbers as bytes
understates usage by 10⁶, which presents as a permanently, reassuringly empty
bandwidth row. `toBytes()` converts through the declared unit and refuses to
guess an unrecognised one.

### Are the gaps real? (`ops:gaps`)

Yes — measured 2026-09-02 over 7 days: 82 gaps, 50 of them past the 15-minute
idle threshold, **110.8h up out of 168h**. The service spins down as designed, is
woken ~12x/day, and every wake re-reads the whole boot payload. The cold-start
rate the egress model multiplies by is sound.

⚠ **It looked otherwise, and the trap is worth keeping.** The report's own two
figures appeared to contradict each other: 93–96% uptime beside 12.6 cold
starts/day is an average gap under 7 minutes, which is shorter than Render will
wait before spinning anything down. They measure different **windows**. The
report's uptime is cycle-to-date, the cycle was two days old, and across those
two days the service had stopped spinning down. Both numbers were right about
their own window, and the shorter one was unrepresentative of the month.

So [`scripts/ops/gaps.mjs`](../scripts/ops/gaps.mjs) prints a histogram bucketed
either side of the idle threshold **and** a per-day uptime breakdown, from the
same endpoint `--discover` dumps ten thousand timestamps of. The per-day half is
not decoration: an average over a week cannot show you the day the behaviour
changed, and that day was the finding.

**⚠ Render reports no instance-count for free services** — `200` with an empty
array. That is a plan limitation, not a zero, so it is left **unreported**;
recording 0 would read as a wide-open budget on the metric a 24/7 free service
is most likely to exhaust (750 h/month is only ~30 h above a full month of
wall-clock — see [`server/keepalive.js`](../server/keepalive.js)). Read it from
the dashboard: **Billing → Usage**.

**Build minutes are derived**, by summing deploy durations, because Render
exposes no build-minutes endpoint. Labelled `derived` everywhere it travels.

---

## 6. Runbook — what to do when a row goes red

| Row | First thing to check |
|---|---|
| **Neon egress** | The attribution block. High payload → trim boot-tier tables. `zones.description` was the biggest named win and is **done** (2026-09-02 — read off the checkout, see architecture.md → *read it off the checkout*); what is left is `zones.flags`/`exits` (hot, not trimmable), `npcs.dialogue_tree` ~0.70MB, `media_broadcasts.broadcast_graph` ~0.63MB and `power_zones`. High loads/day → deploy frequency, or Render cold starts. Model ≪ API → something other than world boot is reading prod. **The first place to look is the dev API, not the game**: `fireHook('zone.update')` fires on every `PUT /zones/:id`, the map painter saves one tile per request, and until 2026-09-03 the zone-validator answered each one with a full `SELECT id FROM zones` (~0.5MB × every tile a brush touched — 900MB in one evening on 2026-09-02). Egress that tracks *your* activity rather than the player count is tooling, and `npm run db:query-lint -- --all` is where it shows up as a `cached-table-read` advisory. |
| **Neon compute** | A tick pinning a connection stops Neon suspending. See the persistence tiers in [architecture.md](architecture.md) and `hasActivePlayers()` idle-gating. |
| **Neon storage** | `neon_usage_log.top_tables` names the biggest tables; the report prints growth per day. |
| **Neon branches** | Almost always `predeploy-*` snapshots. The prune in `deploy-content.yml` keeps the newest 5 but is `continue-on-error`, so a wedged prune is silent — until the *next* deploy's snapshot fails and aborts the deploy before prod. Delete stale branches in the Neon console. |
| **Render bandwidth** | Client asset payload, then player count. |
| **Render instance hours** | `keepalive.js` idle-gating, and whether the service is spinning down at all. |
| **Render build minutes** | Deploy frequency. `autoDeploy: false`, so this is CI's deploy hook. |

---

## 7. Running it

Keys live in **`.env`** (git-ignored), not `.env.prod` — so a
`--env-file=.env.prod` one-shot never carries them:

```
NEON_API_KEY=…       # console.neon.tech → Settings → API keys
RENDER_API_KEY=…     # dashboard.render.com → Account Settings → API Keys
OPS_WEBHOOK_URL=…    # Discord channel → Integrations → Webhooks
```

| Command | Does |
|---|---|
| `npm run ops:usage` | Verdict table, attribution, alert if warranted. |
| `npm run ops:usage:discover` | Raw API payloads, no verdicts. Use when a shape changes. ⚠ A week of CPU samples is ~10,000 timestamps, so this scrolls off a terminal — redirect it (`> dump.json`) rather than reading it live, and reach for `ops:gaps` when the question is about uptime. |
| `npm run ops:gaps` | Gap histogram over Render's CPU timeline — tells a spin-down from a missed scrape. `--days N` to widen the window. |
| `npm run ops:smoke` | The pure decision logic. Wired into `pretest:regress`. |

Flags: `--json`, `--no-alert`, `--no-db` (skip attribution), `--fail-on-alert`
(non-zero exit for a CI caller).

**Exit code is 0 even when CRITICAL, by default.** This is a reporter, not a
gate: a monitor that fails a scheduled task because usage is high produces a red
task every day for the rest of the cycle, which is how a monitor gets muted.

### Alerting

Discord/Slack webhook. Posts on a band **change**, then at most once per 20h
while the band stays bad — so an hourly cron and a daily one produce the same
volume. A green run is silent unless it is a *recovery*.

**The alarm never raises the alarm.** Every webhook failure prints and returns
false; the full report is always written to stdout first, so a failed post loses
the notification, never the information. Same doctrine as the `notify` job in
`deploy-content.yml`, which learned it from a GitHub outage painting green
deploys red.

### Scheduling

**The Actions cron is the runner.** A local Windows scheduled task was used during
build-out and has been **retired** — running both would double the daily rows and
have the two of them fight over `usage-history.json`, since CI commits it to main.
Run `npm run ops:usage` by hand for a reading between crons.

Gaps are harmless either way: **every run re-reads the full cumulative total from
both providers** — nothing here is a delta accumulator, so the history file only
feeds the 7-day trend and alert de-duplication.

**Phase 2 — [`.github/workflows/usage-watch.yml`](../.github/workflows/usage-watch.yml)**,
daily on `schedule: '17 8 * * *'`. Off-the-hour, per the cron-delay lesson
`deploy-content.yml` records at `:37` (29–106 min dispatch delays measured on
this repo at `:00`).

**Three keys are in three different places, and only one of them is the repo.**
`.env` on the developer's machine is git-ignored, so it is not in the checkout,
so an Actions runner never sees it — the same values must exist independently as
**repo secrets**. `.env.prod` is a third store and is deliberately not involved:
keeping ops keys out of it means a `--env-file=.env.prod` one-shot never carries
an API key into an unrelated script.

| Secret | Present | Used for |
|---|---|---|
| `NEON_API_KEY` | yes | the Neon half |
| `PROD_DATABASE_URL` | yes | attribution (boot payload, world loads/day) |
| `RENDER_API_KEY` | yes | the Render half |
| `OPS_WEBHOOK_URL` | yes | Discord alerting |

**Missing secrets degrade, they do not break.** The two that exist already carry
the Neon report and the whole attribution model, so the workflow is useful the
day it lands; the report exits 0 on every collection failure and records the
reason as a note, and a step raises a workflow *annotation* naming what is
absent. Adding the secrets later needs no change to the file. This is deliberate:
a job that went red every morning until somebody acted would train the team to
ignore it, which is the failure this whole system exists to avoid.

Adding a secret needs repo **admin**, which johna does not have (`admin: false` on
`HaveAGreatDave/architect-mud`) — so any future secret is an owner ask.

⚠ **The commit-back's `[skip ci]` marker is load-bearing.** `sync-commits.yml`
triggers on *every* push to main with no path filter and writes to the prod
database. Without the marker, a bookkeeping commit whose only purpose is to
record a number would kick off a prod DB write every morning. (`data/ops/**` is
already outside `deploy-content.yml`'s push filter, so a content deploy was
never at risk.)

---

## 8. History

`data/ops/usage-history.json`, one row per run. **Not a DB table**: the thing
being measured is DB egress, and a monitor that writes to prod every run spends
from the budget it reports on. A flat file costs nothing and makes the trend
readable with `git log -p`. `data/**` is outside `deploy-content.yml`'s push path
filter, so committing it cannot trigger a production deploy.
