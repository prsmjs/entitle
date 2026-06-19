<p align="center">
  <img src="logo.svg" width="80" height="80" alt="entitle logo">
</p>

<h1 align="center">@prsm/entitle</h1>

<p align="center">
  <a href="https://github.com/prsmjs/entitle/actions/workflows/test.yml"><img src="https://github.com/prsmjs/entitle/actions/workflows/test.yml/badge.svg" alt="test"></a>
  <a href="https://www.npmjs.com/package/@prsm/entitle"><img src="https://img.shields.io/npm/v/@prsm/entitle" alt="npm"></a>
</p>

Plan-based entitlements and feature gating, backed by postgres. Declare your pricing tiers once, assign subjects to plans, and ask at runtime what a subject is allowed to do. Entitlements resolve live on every call, so an upgrade, a negotiated override, or a crossed usage threshold takes effect immediately rather than at the next restart.

It pairs with [@prsm/meter](https://www.npmjs.com/package/@prsm/meter): meter answers how much a subject has used, entitle answers what their plan allows and where the ceiling is. Hand entitle a meter and `check()` reads usage live and compares it to the resolved limit.

## Installation

```bash
npm install @prsm/entitle pg
```

## Quick start

```js
import { createEntitlements, postgresDriver } from "@prsm/entitle"
import pg from "pg"

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

const entitlements = createEntitlements({
  driver: postgresDriver({ pool }),
  defaultPlan: "free",
  features: ["api_access", "export_csv", "sso"], // the universe of valid feature keys
  limits: ["tokens", "seats"],                    // the universe of valid limit keys
  plans: {
    free: {
      features: { api_access: true, export_csv: false, sso: false },
      limits: { tokens: 100_000, seats: 1 },
    },
    pro: {
      features: { api_access: true, export_csv: true, sso: false },
      limits: { tokens: 5_000_000, seats: 10 },
    },
    enterprise: {
      features: { api_access: true, export_csv: true, sso: true },
      limits: { tokens: null, seats: null }, // null means unlimited
    },
  },
})

await entitlements.setup() // create tables if they do not exist; idempotent
```

Declaring `features` and `limits` up front is the catalog: plans may only reference keys in it, and `can()`/`limit()`/`check()` throw on any other key, so a typo (`can(id, "exprot_csv")`) surfaces instead of silently returning `false`. The declarations are optional - if you omit them the universe is derived from the union of keys across your plans - but declaring them also catches typos in the plan definitions themselves.

Gating a feature and a quota on a request:

```js
async function exportReport(account) {
  if (!(await entitlements.can(account.id, "export_csv"))) {
    throw new Error("CSV export is not available on your plan")
  }
  // ...
}
```

Assigning plans and per-subject overrides as customers upgrade or negotiate:

```js
await entitlements.assign(account.id, "pro")              // takes effect immediately
await entitlements.override(account.id, { limits: { seats: 50 } }) // the enterprise customer who negotiated more seats
await entitlements.override(account.id, { features: { sso: true } })
```

## Composing with the meter

`check()` is the seam between the two packages. Entitle resolves the limit; meter supplies live usage. Pass a `@prsm/meter` instance and check a limit key that is also a meter metric:

```js
import { createMeter, postgresDriver as meterPostgres } from "@prsm/meter"

const meter = createMeter({
  driver: meterPostgres({ pool }),
  metrics: { tokens: { unit: "tokens", aggregate: "sum" } },
})

const entitlements = createEntitlements({
  driver: postgresDriver({ pool }),
  defaultPlan: "free",
  plans: { /* ... */ },
  meter,
})

// account.id is assigned the "pro" plan, whose tokens limit is 5_000_000
const quota = await entitlements.check(account.id, "tokens")
// { allowed: true, used: 84210, remaining: 4915790, limit: 5000000, unit: "tokens", feature: "tokens" }

if (!quota.allowed) throw new Error("monthly token limit reached")
```

Because the limit is resolved from the plan and the usage is read from the meter on every call, the same code path enforces a tightened plan, a granted override, and a depleting quota without any of it being baked in at startup.

### Who owns what

Entitle does not track usage. It has no usage state of its own. In the result above, `limit: 5000000` comes from the plan (entitle's only input), `used: 84210` comes from a single live `meter.usage()` call that `check()` makes for you, and `remaining` is just `limit - used`. All accrual happens in your application calling `meter.record(...)` on each usage event; meter stores and aggregates it. So meter owns "how much have they used," entitle owns "what is the ceiling," and `check()` fetches the ceiling, asks meter for the usage, and subtracts. Pass `meter` only to enable that one call - without it, use `limit()` for the ceiling and read usage from meter yourself.

Two things must line up for `check()` to work:

- **Same subject identifier.** `check(subject, key)` calls `meter.usage({ subject, ... })`, so the `subject` you pass here must be the same id you record usage under in meter.
- **Matching key.** The entitle limit key must equal the meter metric name (`check(id, "tokens")` reads the `tokens` metric). If the metric does not exist in the meter, meter throws.

## Plans, assignments, and overrides

The **plan catalog** is declared once at construction, the way you declare your pricing tiers in code. A plan grants:

- **features** - a map of capability flags (`{ sso: true, export_csv: false }`), read with `can()`.
- **limits** - a map of numeric ceilings keyed by name (`{ tokens: 5_000_000, seats: 10 }`), read with `limit()` and enforced with `check()`. A `null` limit means unlimited; a known limit a plan does not grant resolves to `0` (no allowance), never silently unlimited.

**Assignments** (which plan a subject is on) and **overrides** (per-subject adjustments) live in postgres and are mutable at runtime. An override shallow-merges over the plan, so you specify only what differs. A subject with no assignment gets `defaultPlan`; `unassign(subject)` removes an assignment and reverts the subject to the default (distinct from assigning the default explicitly, which would not follow a later change to `defaultPlan`).

Overrides accumulate: each `override()` call merges into the subject's existing override rather than replacing it, so granting more seats and later enabling a feature leaves both in place, and overriding a key again updates just that key. The merge happens in the database under a row lock, so two concurrent overrides to the same subject both land instead of one clobbering the other. `clearOverride(subject)` removes the whole override; `clearOverride(subject, { limits: ["seats"] })` reverts only the named keys and keeps the rest.

```js
await entitlements.override(account.id, { limits: { seats: 50 } })
await entitlements.override(account.id, { features: { sso: true } }) // seats override stays
await entitlements.clearOverride(account.id, { limits: ["seats"] })   // seats reverts to plan, sso stays
await entitlements.clearOverride(account.id)                          // back to plain plan
```

Resolved entitlements are cached per subject for a short, configurable window (`cacheTtl`, default `"10s"`) and the cache is invalidated immediately on `assign`, `override`, and `clearOverride`, so the instance making a change sees it at once and other instances converge within the TTL. Set `cacheTtl: 0` to read postgres on every call.

## API

### `createEntitlements({ driver, plans, defaultPlan, features?, limits?, meter?, cacheTtl?, tracer? })`

Creates a resolver. `driver` is `postgresDriver({ pool })` or `memoryDriver()`. `plans` is the catalog; `defaultPlan` must be one of its keys. `features` and `limits` declare the universe of valid keys (defaulting to the union across plans); when given, plans may only reference declared keys. `meter` is an optional `@prsm/meter` instance, required only for `check()`. `cacheTtl` accepts ms or a string like `"10s"`. `tracer` is an optional `@prsm/trace` tracer; `can()` and `check()` are wrapped in spans when it is present.

### `entitlements.setup()`

Creates the backing tables if they do not exist. Idempotent.

### `entitlements.assign(subject, plan)`

Assigns a subject to a plan. Takes effect immediately.

### `entitlements.unassign(subject)`

Removes a subject's assignment, reverting them to the default plan.

### `entitlements.override(subject, { features?, limits? })`

Layers a per-subject override on top of the plan. Shallow-merges; pass only what differs.

### `entitlements.clearOverride(subject, keys?)`

With no `keys`, removes the subject's entire override. With `keys` (`{ features?: string[], limits?: string[] }`), removes only those entries and keeps the rest.

### `entitlements.can(subject, feature)`

Returns whether a capability flag is granted (`false` for an ungranted feature). Throws on a feature key outside the catalog, so typos surface instead of silently returning `false`.

### `entitlements.limit(subject, key)`

Returns the numeric ceiling for a limit key after overrides: `null` only for an explicitly unlimited limit, `0` for a known limit the plan does not grant. Throws on a key outside the catalog. Does not read usage.

### `entitlements.check(subject, key, usageQuery?)`

Resolves the limit and reads live usage from the meter, returning `{ allowed, used, remaining, limit, unit, feature }`. `usageQuery` is forwarded to `meter.usage` (for example `{ period: "day" }`). Requires a `meter`.

### `entitlements.plan(subject)`

Returns the subject's effective plan name.

### `entitlements.describe(subject)`

Returns the full effective snapshot `{ plan, features, limits }`, for a settings or billing page.

### `entitlements.catalog()`

Returns the static configuration `{ defaultPlan, plans, features, limits }`: every declared plan, the default plan, and the full feature and limit universes. Where `describe` resolves a single subject, `catalog` exposes the whole offering, for a plan comparison table, an admin dashboard, or documenting what the system grants. Subject-independent and read-only, so it never touches storage. The returned object is a fresh copy.

### `entitlements.close()`

Releases driver resources.

## Storage

Two postgres tables, prefixed `entitle_` by default (pass `prefix` to `postgresDriver` to run several resolvers in one database):

- `entitle_assignments` maps a subject to a plan.
- `entitle_overrides` holds each subject's override as JSON.

The plan catalog itself is code, not data, so it is not stored.

## Testing

The `memoryDriver` mirrors the postgres driver and needs no infrastructure:

```js
import { createEntitlements, memoryDriver } from "@prsm/entitle"

const entitlements = createEntitlements({
  driver: memoryDriver(),
  defaultPlan: "free",
  plans: { free: { features: { api_access: true }, limits: { seats: 1 } } },
})
await entitlements.setup()
```

It is not durable; use it for tests, not production.

## License

MIT
