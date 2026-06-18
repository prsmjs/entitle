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

const quota = await entitlements.check(account.id, "tokens")
// { allowed: true, used: 84210, remaining: 4915790, limit: 5000000, unit: "tokens", feature: "tokens" }

if (!quota.allowed) throw new Error("monthly token limit reached")
```

Because the limit is resolved from the plan and the usage is read from the meter on every call, the same code path enforces a tightened plan, a granted override, and a depleting quota without any of it being baked in at startup.

## Plans, assignments, and overrides

The **plan catalog** is declared once at construction, the way you declare your pricing tiers in code. A plan grants:

- **features** - a map of capability flags (`{ sso: true, export_csv: false }`), read with `can()`.
- **limits** - a map of numeric ceilings keyed by name (`{ tokens: 5_000_000, seats: 10 }`), read with `limit()` and enforced with `check()`. A `null` limit means unlimited.

**Assignments** (which plan a subject is on) and **overrides** (per-subject adjustments) live in postgres and are mutable at runtime. An override shallow-merges over the plan, so you specify only what differs. A subject with no assignment gets `defaultPlan`.

Overrides accumulate: each `override()` call merges into the subject's existing override rather than replacing it, so granting more seats and later enabling a feature leaves both in place, and overriding a key again updates just that key. `clearOverride(subject)` removes the whole override; `clearOverride(subject, { limits: ["seats"] })` reverts only the named keys and keeps the rest.

```js
await entitlements.override(account.id, { limits: { seats: 50 } })
await entitlements.override(account.id, { features: { sso: true } }) // seats override stays
await entitlements.clearOverride(account.id, { limits: ["seats"] })   // seats reverts to plan, sso stays
await entitlements.clearOverride(account.id)                          // back to plain plan
```

Resolved entitlements are cached per subject for a short, configurable window (`cacheTtl`, default `"10s"`) and the cache is invalidated immediately on `assign`, `override`, and `clearOverride`, so the instance making a change sees it at once and other instances converge within the TTL. Set `cacheTtl: 0` to read postgres on every call.

## API

### `createEntitlements({ driver, plans, defaultPlan, meter?, cacheTtl?, tracer? })`

Creates a resolver. `driver` is `postgresDriver({ pool })` or `memoryDriver()`. `plans` is the catalog; `defaultPlan` must be one of its keys. `meter` is an optional `@prsm/meter` instance, required only for `check()`. `cacheTtl` accepts ms or a string like `"10s"`. `tracer` is an optional `@prsm/trace` tracer.

### `entitlements.setup()`

Creates the backing tables if they do not exist. Idempotent.

### `entitlements.assign(subject, plan)`

Assigns a subject to a plan. Takes effect immediately.

### `entitlements.override(subject, { features?, limits? })`

Layers a per-subject override on top of the plan. Shallow-merges; pass only what differs.

### `entitlements.clearOverride(subject, keys?)`

With no `keys`, removes the subject's entire override. With `keys` (`{ features?: string[], limits?: string[] }`), removes only those entries and keeps the rest.

### `entitlements.can(subject, feature)`

Returns whether a capability flag is granted (`false` for an ungranted or unknown feature).

### `entitlements.limit(subject, key)`

Returns the numeric ceiling for a limit key after overrides, or `null` for an unlimited or undeclared limit. Does not read usage.

### `entitlements.check(subject, key, usageQuery?)`

Resolves the limit and reads live usage from the meter, returning `{ allowed, used, remaining, limit, unit, feature }`. `usageQuery` is forwarded to `meter.usage` (for example `{ period: "day" }`). Requires a `meter`.

### `entitlements.plan(subject)`

Returns the subject's effective plan name.

### `entitlements.describe(subject)`

Returns the full effective snapshot `{ plan, features, limits }`, for a settings or billing page.

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
