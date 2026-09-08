// Render consumption collector.
//
// THE SERVICE IS RESOLVED AT RUNTIME, AND DELIBERATELY NOT BY A SINGLE NAME.
// This service has been called two different things: the 2026-07-26 account
// cutover created `architect-mud-live` by hand, and the name was later reclaimed
// back to `architect-mud` once the old suspended service was deleted. A script
// pinned to either name reports on nothing for half of the project's history —
// and "no data" from a monitor reads like "no problem". So we try the known
// names in order and then fall back to the sole web service, which is correct
// for as long as this workspace hosts one game.
//
// WHAT IS MEASURED VS WHAT IS DERIVED. Bandwidth and instance-count come from
// Render's metrics API and are observations. Build minutes are DERIVED by
// summing deploy durations, because Render exposes no build-minutes endpoint —
// that figure is labelled `derived: true` everywhere it travels, and the report
// prints it differently, because a guess presented like a measurement is worse
// than no number at all.
//
// Auth: RENDER_API_KEY (dashboard.render.com → Account Settings → API Keys).
const API = 'https://api.render.com/v1';

// Preference order. RENDER_SERVICE_NAME overrides everything if this workspace
// ever holds a second game.
export const SERVICE_NAMES = [
  process.env.RENDER_SERVICE_NAME,
  'architect-mud',
  'architect-mud-live',
].filter(Boolean);

/** Pick the production service out of a workspace listing. */
export function pickService(services) {
  for (const name of SERVICE_NAMES) {
    const hit = services.find((s) => s.name === name);
    if (hit) return { service: hit, how: `matched name "${name}"` };
  }
  const web = services.filter((s) => s.type === 'web_service');
  if (web.length === 1) return { service: web[0], how: `only web service in the workspace ("${web[0].name}")` };
  return { service: null, how: null };
}

// Exported so a focused diagnostic (scripts/ops/gaps.mjs) can ask the same API
// the same way, rather than growing a second fetch wrapper with its own idea of
// what an error looks like.
export async function api(path, key) {
  const res = await fetch(`${API}${path}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Render ${path.split('?')[0]} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

// Render list endpoints return [{ <entity>: {...}, cursor }]; single-object
// endpoints return the object bare. Accept both so a shape change downgrades to
// "not found" rather than throwing halfway through the report.
function unwrapList(body, entityKey) {
  if (!Array.isArray(body)) return [];
  return body.map((row) => row?.[entityKey] ?? row).filter(Boolean);
}

// ⚠ RENDER'S BANDWIDTH SERIES IS NOT IN BYTES. Each series carries its own
// `unit` field and the observed value for bandwidth is "mb" — so summing the
// raw numbers as bytes understates usage by a factor of a million, which
// presents as a permanently, reassuringly empty bandwidth row. Always convert
// through the declared unit; never assume.
//
// Render's "mb" is decimal megabytes (10^6). The limit in limits.js is in
// binary GiB (2^30), so the two differ by ~7% at the top end. That is well
// inside the precision this report needs (we act on 80%, not 80.0%), and
// erring toward reporting slightly MORE usage than the provider counts is the
// safe direction for a budget alarm.
const UNIT_BYTES = {
  b: 1, bytes: 1,
  kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
  kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3,
};

export function toBytes(value, unit) {
  const mult = UNIT_BYTES[String(unit ?? '').toLowerCase()];
  return mult === undefined ? null : value * mult;
}

/**
 * Metrics series → { points: [{ t, v }], unit }.
 * Render returns [{ labels, unit, values: [{ timestamp, value }] }]; if several
 * series come back (one per instance) they are summed per timestamp.
 */
function flattenSeries(body) {
  const series = Array.isArray(body) ? body : body?.values ? [body] : [];
  const byTime = new Map();
  let unit = null;
  for (const s of series) {
    if (s?.unit && !unit) unit = s.unit;
    for (const p of s?.values ?? []) {
      const t = new Date(p.timestamp ?? p.time).getTime();
      const v = Number(p.value);
      if (Number.isNaN(t) || Number.isNaN(v)) continue;
      byTime.set(t, (byTime.get(t) ?? 0) + v);
    }
  }
  const points = [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t: new Date(t), v }));
  return { points, unit };
}

/**
 * Integrate a step series to a total in hours.
 *
 * Uses each sample's own gap to the next rather than an assumed resolution:
 * Render's metrics resolution varies with the window length, so a hardcoded
 * "5 minutes per sample" silently mis-scales the total by whatever factor the
 * real spacing differs by — and a wrong instance-hours figure against a 750-hour
 * cap is exactly the alert we would most regret getting wrong.
 */
function integrateHours(points, endTime) {
  let hours = 0;
  for (let i = 0; i < points.length; i += 1) {
    const next = i + 1 < points.length ? points[i + 1].t : endTime;
    const gapH = (next - points[i].t) / 3_600_000;
    if (gapH > 0) hours += points[i].v * gapH;
  }
  return hours;
}

export async function collectRender({ apiKey, now = new Date(), cycleStart } = {}) {
  const key = apiKey ?? process.env.RENDER_API_KEY;
  if (!key) throw new Error('RENDER_API_KEY is not set (put it in .env)');

  // Render's cycle boundary is not exposed by the API, so unless the caller
  // supplies one we use the calendar month in UTC and SAY SO. The report labels
  // an assumed boundary distinctly from Neon's reported one.
  const start = cycleStart ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const assumedCycle = !cycleStart;

  const notes = [];
  const raw = {};
  const metrics = {};
  let uptime = null;

  const services = unwrapList(await api('/services?limit=100', key), 'service');
  raw.services = services.map((s) => ({ id: s.id, name: s.name, type: s.type, suspended: s.suspended }));

  const { service: svc, how } = pickService(services);
  if (!svc) {
    const names = services.map((s) => s.name).join(', ') || '(none)';
    throw new Error(`No production Render service found (tried: ${SERVICE_NAMES.join(', ')}). Visible services: ${names}. Set RENDER_SERVICE_NAME to override.`);
  }
  const plan = svc.serviceDetails?.plan ?? null;
  raw.service = { id: svc.id, name: svc.name, plan, suspended: svc.suspended, resolvedBy: how };
  if (plan && plan !== 'free') {
    notes.push(`service "${svc.name}" is on the "${plan}" plan, not free — instance-hours and bandwidth allowances differ from the free ceilings used below`);
  }
  if (services.length > 1) {
    notes.push(`${services.length} services in this workspace — bandwidth and instance-hour quotas are WORKSPACE-wide, but only "${svc.name}" is measured, so the real total is higher`);
  }

  const qs = `resource=${svc.id}&startTime=${start.toISOString()}&endTime=${now.toISOString()}`;

  // --- Bandwidth (measured) ---
  try {
    raw.bandwidth = await api(`/metrics/bandwidth?${qs}`, key);
    const { points, unit } = flattenSeries(raw.bandwidth);
    if (points.length) {
      // Bandwidth samples are per-interval totals, so the cycle figure is their
      // SUM — not a time integral like instance-count.
      const summed = points.reduce((a, p) => a + p.v, 0);
      const bytes = toBytes(summed, unit);
      if (bytes === null) {
        notes.push(`bandwidth returned an unrecognised unit "${unit}" — refusing to guess the scale, so bandwidth is not reported this run`);
      } else {
        metrics['render.bandwidth'] = bytes;
      }
    } else {
      notes.push('bandwidth returned no samples — either genuinely zero, or the response shape changed (check --discover)');
    }
  } catch (e) {
    notes.push(`bandwidth unavailable (${e.message.split('\n')[0]})`);
  }

  // --- Instance hours + cold starts, DERIVED FROM THE CPU TIMELINE ----------
  //
  // Render exposes no instance-hours endpoint and returns nothing at all from
  // /metrics/instance-count for a free service (below). But /metrics/cpu does
  // answer, and it only emits a sample WHILE AN INSTANCE IS RUNNING — so the
  // sample timeline is a direct record of uptime, and its gaps are spin-downs.
  // That gives both numbers the free plan otherwise hides:
  //   • uptime  = sample count x the series resolution
  //   • cold starts = gaps materially longer than that resolution
  //
  // This is the platform's own view, and it is authoritative over the
  // player_count_log gap count in attribution.mjs, which cannot see the
  // difference between "server down" and "server up with nobody on it".
  // ⚠ TWO WINDOWS, AND THEY ARE DIFFERENT QUESTIONS.
  //
  //   instance HOURS is a billing quantity — it must be measured over the
  //   billing CYCLE, because that is what the 750 h resets against.
  //
  //   the cold-start RATE is a behavioural property of the service, and must be
  //   measured over a trailing window instead. Reading it from the cycle window
  //   makes it useless for the first days of every month: at 03:00 on the 1st
  //   the cycle is three hours old, which is far too short to establish a rate,
  //   so the egress model would silently fall back to the undercounting
  //   player_count_log figure on exactly the days the report is most watched.
  const RATE_WINDOW_DAYS = 7;
  const rateStart = new Date(now.getTime() - RATE_WINDOW_DAYS * 86_400_000);
  const cpuStamps = async (from) => {
    const body = await api(`/metrics/cpu?resource=${svc.id}&startTime=${from.toISOString()}&endTime=${now.toISOString()}`, key);
    return {
      body,
      stamps: [...new Set(
        (Array.isArray(body) ? body : []).flatMap((s) => (s.values ?? []).map((v) => +new Date(v.timestamp))),
      )].filter((n) => !Number.isNaN(n)).sort((a, b) => a - b),
    };
  };

  try {
    const cycleCpu = await cpuStamps(start);
    raw.cpu = cycleCpu.body;
    const stamps = cycleCpu.stamps;

    if (stamps.length > 2) {
      // Resolution is taken as the MODAL gap, not the minimum: Render coarsens
      // the series as the window widens (1 min over a week, wider over a
      // month), and a single anomalous short gap would otherwise set the scale
      // for the whole calculation.
      const counts = new Map();
      for (let i = 1; i < stamps.length; i += 1) {
        const g = stamps[i] - stamps[i - 1];
        counts.set(g, (counts.get(g) ?? 0) + 1);
      }
      const resMs = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];

      metrics['render.instanceHours'] = (stamps.length * resMs) / 3_600_000;

      // The RATE comes from the trailing window, never the cycle one (above).
      // Reuse the cycle series when it is already long enough, so an established
      // cycle costs one request rather than two.
      const cycleDays = (stamps[stamps.length - 1] - stamps[0]) / 86_400_000;
      const rate = cycleDays >= RATE_WINDOW_DAYS
        ? { stamps, res: resMs }
        : await cpuStamps(rateStart).then((r) => ({ stamps: r.stamps, res: null }));

      let rs = rate.res;
      if (rs === null && rate.stamps.length > 2) {
        const c = new Map();
        for (let i = 1; i < rate.stamps.length; i += 1) {
          const g = rate.stamps[i] - rate.stamps[i - 1];
          c.set(g, (c.get(g) ?? 0) + 1);
        }
        rs = [...c.entries()].sort((a, b) => b[1] - a[1])[0][0];
      }

      // A gap of more than 3x the resolution is a genuine outage, not a missed
      // scrape. Same threshold and reasoning as attribution.mjs's GAP_MIN.
      let coldStarts = 0;
      if (rs) for (let i = 1; i < rate.stamps.length; i += 1) if (rate.stamps[i] - rate.stamps[i - 1] > rs * 3) coldStarts += 1;
      const rateDays = rate.stamps.length > 1
        ? (rate.stamps[rate.stamps.length - 1] - rate.stamps[0]) / 86_400_000
        : 0;

      uptime = {
        hours: metrics['render.instanceHours'],
        resolutionMin: resMs / 60_000,
        cycleDays,
        rateWindowDays: rateDays,
        coldStarts,
        coldStartsPerDay: rateDays > 0.5 ? (coldStarts + 1) / rateDays : null,
      };
    }
  } catch (e) {
    notes.push(`cpu timeline unavailable (${e.message.split('\n')[0]}) — instance hours and cold starts not derived`);
  }

  // --- Instance count (the endpoint that does not answer on free) ----------
  // ⚠ Free services report NOTHING here: the endpoint answers 200 with an empty
  // array. That is a plan limitation, not an outage and not a zero — so it must
  // never be recorded as 0 hours, which would read as a wide-open budget on the
  // one metric a 24/7 free service is most likely to exhaust (750 h/month is
  // only 30 h above a full month of wall-clock; see server/keepalive.js).
  try {
    raw.instanceCount = await api(`/metrics/instance-count?${qs}`, key);
    const { points } = flattenSeries(raw.instanceCount);
    if (points.length) {
      // Paid plans do answer here, and a real instance count beats the CPU
      // proxy because it counts CONCURRENT instances, which the timeline cannot.
      metrics['render.instanceHours'] = integrateHours(points, now);
      if (uptime) uptime.supersededByInstanceCount = true;
    } else if (!uptime) {
      notes.push('instance hours: no instance-count series (free plan) and the CPU timeline gave nothing either — read it from the dashboard, Billing → Monthly Included Usage. Left unreported rather than recorded as zero.');
    } else {
      notes.push(`instance hours DERIVED from the CPU sample timeline (${uptime.resolutionMin}-min resolution over ${uptime.cycleDays.toFixed(1)} days of this cycle) — Render returns no instance-count series on the free plan. Cross-check against Billing → Monthly Included Usage.`);
    }
  } catch (e) {
    notes.push(`instance-count unavailable (${e.message.split('\n')[0]})`);
  }

  // --- Build minutes (DERIVED, not measured) ---
  try {
    raw.deploys = await api(`/services/${svc.id}/deploys?limit=100`, key);
    const deploys = unwrapList(raw.deploys, 'deploy');
    let minutes = 0;
    let counted = 0;
    let truncated = deploys.length >= 100;
    for (const d of deploys) {
      const created = new Date(d.createdAt ?? d.created_at);
      if (Number.isNaN(created.getTime()) || created < start) continue;
      const finished = new Date(d.finishedAt ?? d.updatedAt ?? now);
      const mins = (finished - created) / 60_000;
      if (mins > 0) { minutes += mins; counted += 1; }
    }
    metrics['render.buildMinutes'] = minutes;
    metrics['render.buildMinutes.derived'] = true;
    notes.push(`build minutes DERIVED from ${counted} deploy duration(s) this cycle — Render exposes no build-minutes endpoint, so treat as an estimate`);
    if (truncated) notes.push('deploy list hit the 100-row page limit — build-minutes estimate may be low');
  } catch (e) {
    notes.push(`deploys unavailable (${e.message.split('\n')[0]})`);
  }

  // Worth knowing for the report header even though it has no quota.
  try {
    raw.owners = unwrapList(await api('/owners?limit=20', key), 'owner').map((o) => ({ id: o.id, name: o.name, type: o.type }));
  } catch { /* non-fatal: owner is informational only */ }

  return { metrics, cycleStart: start, assumedCycle, service: svc, uptime, raw, notes };
}
