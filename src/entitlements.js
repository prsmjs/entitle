import ms from "@prsm/ms"

/**
 * @typedef {Object} Plan
 * @property {Record<string, boolean>} [features] - capability flags this plan grants (`{ sso: true, export_csv: false }`)
 * @property {Record<string, number|null>} [limits] - numeric ceilings keyed by metric name; `null` means unlimited (`{ tokens: 1000000, seats: 5 }`)
 */

/**
 * @typedef {Object} Override
 * A per-subject override layered on top of the subject's plan. Shallow-merges
 * over the plan, so you only specify what differs (the enterprise customer who
 * negotiated more seats, or got one feature switched on).
 * @property {Record<string, boolean>} [features]
 * @property {Record<string, number|null>} [limits]
 */

/**
 * @typedef {Object} EntitlementsOptions
 * @property {Object} driver - storage backend: `postgresDriver({ pool })` for production, `memoryDriver()` for tests
 * @property {Record<string, Plan>} plans - the plan catalog, declared once at construction (your pricing tiers)
 * @property {string} defaultPlan - plan applied to a subject with no assignment; must be a key of `plans`
 * @property {string[]} [features] - the universe of valid feature keys. When given, plans may only reference these and `can()` throws on any other key (catches typos). Defaults to the union of feature keys across all plans
 * @property {string[]} [limits] - the universe of valid limit keys. When given, plans may only reference these and `limit()`/`check()` throw on any other key. Defaults to the union of limit keys across all plans
 * @property {{ usage: Function }} [meter] - optional `@prsm/meter` instance; required only for `check()`, which reads live usage from it
 * @property {number|string} [cacheTtl] - how long resolved plan/override state is cached per subject, ms or a string like `"10s"` (default `"10s"`, `0` disables). Kept short and invalidated on writes so entitlements stay runtime-evaluated, never startup-frozen
 * @property {{ startSpan: Function }} [tracer] - optional `@prsm/trace` tracer
 */

/**
 * @typedef {Object} Effective
 * @property {string} plan - the effective plan name
 * @property {Record<string, boolean>} features
 * @property {Record<string, number|null>} limits
 */

/**
 * @typedef {Object} CheckResult
 * @property {boolean} allowed - whether current usage is below the limit (always true when the limit is unlimited)
 * @property {number} used - current usage, read live from the meter
 * @property {number|null} remaining - `max(0, limit - used)`, or `null` when unlimited
 * @property {number|null} limit - the resolved ceiling, or `null` when unlimited
 * @property {string} [unit] - the meter unit for this metric
 * @property {string} feature - the limit key that was checked
 */

function assertBoolean(scope, key, v) {
  if (typeof v !== "boolean") throw new Error(`${scope} feature "${key}" must be a boolean`)
}

function assertLimitValue(scope, key, v) {
  if (v === null) return
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`${scope} limit "${key}" must be a finite number or null (null means unlimited)`)
  }
  if (v < 0) {
    throw new Error(`${scope} limit "${key}" must not be negative (use 0 to deny, null for unlimited)`)
  }
}

/**
 * Validate the plan catalog, derive or enforce the feature/limit universes, and
 * type-check every plan value. Returns the two universes as Sets.
 */
function buildCatalog(plans, defaultPlan, declaredFeatures, declaredLimits) {
  if (!plans || typeof plans !== "object" || Object.keys(plans).length === 0) {
    throw new Error("createEntitlements requires a non-empty `plans` catalog")
  }
  if (!defaultPlan || !plans[defaultPlan]) {
    throw new Error(`createEntitlements requires \`defaultPlan\` to be one of the declared plans: ${Object.keys(plans).join(", ")}`)
  }

  const featureUniverse = new Set(declaredFeatures ?? [])
  const limitUniverse = new Set(declaredLimits ?? [])
  const enforceFeatures = Array.isArray(declaredFeatures)
  const enforceLimits = Array.isArray(declaredLimits)

  for (const [name, plan] of Object.entries(plans)) {
    if (plan.features && typeof plan.features !== "object") throw new Error(`plan "${name}" features must be an object`)
    if (plan.limits && typeof plan.limits !== "object") throw new Error(`plan "${name}" limits must be an object`)
    for (const [k, v] of Object.entries(plan.features ?? {})) {
      assertBoolean(`plan "${name}"`, k, v)
      if (enforceFeatures && !featureUniverse.has(k)) throw new Error(`plan "${name}" references undeclared feature "${k}"`)
      featureUniverse.add(k)
    }
    for (const [k, v] of Object.entries(plan.limits ?? {})) {
      assertLimitValue(`plan "${name}"`, k, v)
      if (enforceLimits && !limitUniverse.has(k)) throw new Error(`plan "${name}" references undeclared limit "${k}"`)
      limitUniverse.add(k)
    }
  }

  return { featureUniverse, limitUniverse }
}

function validateOverride(data, featureUniverse, limitUniverse) {
  if (!data || typeof data !== "object") throw new Error("override data must be an object with `features` and/or `limits`")
  for (const [k, v] of Object.entries(data.features ?? {})) {
    assertBoolean("override", k, v)
    if (!featureUniverse.has(k)) throw new Error(`override references unknown feature "${k}"`)
  }
  for (const [k, v] of Object.entries(data.limits ?? {})) {
    assertLimitValue("override", k, v)
    if (!limitUniverse.has(k)) throw new Error(`override references unknown limit "${k}"`)
  }
}

function createCache(ttl) {
  const store = new Map()
  return {
    get(subject) {
      if (ttl <= 0) return undefined
      const hit = store.get(subject)
      if (!hit) return undefined
      if (hit.expires <= Date.now()) {
        store.delete(subject)
        return undefined
      }
      return hit.value
    },
    set(subject, value) {
      if (ttl <= 0) return
      store.set(subject, { value, expires: Date.now() + ttl })
    },
    invalidate(subject) {
      store.delete(subject)
    },
  }
}

async function traced(tracer, name, attrs, fn) {
  const span = tracer?.startSpan(name, attrs)
  try {
    return await fn()
  } catch (err) {
    span?.setError(err)
    throw err
  } finally {
    span?.end()
  }
}

/**
 * Create an entitlements resolver: given a subject, decide what their plan
 * allows right now. Plans are declared up front; assignments and overrides live
 * in the driver and are resolved live on every call, so a plan change or a
 * crossed usage threshold takes effect immediately, not at the next restart.
 *
 * @param {EntitlementsOptions} options
 */
export function createEntitlements(options = {}) {
  const { driver, plans, defaultPlan, meter = null, tracer = null } = options
  if (!driver) throw new Error("createEntitlements requires a `driver` (postgresDriver or memoryDriver)")
  const { featureUniverse, limitUniverse } = buildCatalog(plans, defaultPlan, options.features, options.limits)

  const catalog = { ...plans }
  const cache = createCache(ms(options.cacheTtl ?? "10s"))

  function requireFeature(feature) {
    if (!featureUniverse.has(feature)) {
      throw new Error(`unknown feature "${feature}". declared features: ${[...featureUniverse].join(", ") || "(none)"}`)
    }
  }
  function requireLimit(key) {
    if (!limitUniverse.has(key)) {
      throw new Error(`unknown limit "${key}". declared limits: ${[...limitUniverse].join(", ") || "(none)"}`)
    }
  }

  async function resolve(subject) {
    if (!subject) throw new Error("a `subject` is required")
    const cached = cache.get(subject)
    if (cached) return cached

    const state = await driver.getState(subject)
    const planName = state?.plan ?? defaultPlan
    const planDef = catalog[planName]
    if (!planDef) {
      throw new Error(`subject "${subject}" is assigned to unknown plan "${planName}"`)
    }
    const override = state?.override ?? {}
    const effective = {
      plan: planName,
      features: { ...(planDef.features ?? {}), ...(override.features ?? {}) },
      limits: { ...(planDef.limits ?? {}), ...(override.limits ?? {}) },
    }
    cache.set(subject, effective)
    return effective
  }

  async function resolveLimit(subject, key) {
    requireLimit(key)
    const eff = await resolve(subject)
    return key in eff.limits ? eff.limits[key] : 0
  }

  return {
    /** Create the backing tables if they do not exist. Idempotent. */
    setup() {
      return driver.setup()
    },

    /**
     * Assign a subject to a plan. Takes effect immediately.
     * @param {string} subject
     * @param {string} plan - a key of the plan catalog
     */
    async assign(subject, plan) {
      if (!subject) throw new Error("assign requires a `subject`")
      if (!catalog[plan]) throw new Error(`unknown plan "${plan}". declared plans: ${Object.keys(catalog).join(", ")}`)
      await driver.assign(subject, plan)
      cache.invalidate(subject)
    },

    /**
     * Remove a subject's plan assignment, reverting them to the default plan.
     * Distinct from assigning the default plan explicitly: an unassigned subject
     * follows `defaultPlan` if it later changes.
     * @param {string} subject
     */
    async unassign(subject) {
      if (!subject) throw new Error("unassign requires a `subject`")
      await driver.unassign(subject)
      cache.invalidate(subject)
    },

    /**
     * Add or adjust a per-subject override, layered on top of the subject's plan.
     * Merges into any existing override for the subject, so repeated calls
     * accumulate: overriding `seats`, then later overriding `sso`, leaves both in
     * place, and overriding a key again updates just that key. Use clearOverride
     * to remove overrides. Takes effect immediately.
     * @param {string} subject
     * @param {Override} data
     */
    async override(subject, data) {
      if (!subject) throw new Error("override requires a `subject`")
      validateOverride(data, featureUniverse, limitUniverse)
      await driver.mergeOverride(subject, { features: data.features ?? {}, limits: data.limits ?? {} })
      cache.invalidate(subject)
    },

    /**
     * Remove overrides for a subject. With no `keys`, removes the entire override
     * and the subject falls back to plain plan entitlements. With `keys`, removes
     * only those override entries (reverting them to the plan) and keeps the rest.
     * @param {string} subject
     * @param {{ features?: string[], limits?: string[] }} [keys]
     */
    async clearOverride(subject, keys) {
      if (!subject) throw new Error("clearOverride requires a `subject`")
      if (!keys) {
        await driver.clearOverride(subject)
      } else {
        await driver.removeOverrideKeys(subject, { features: keys.features ?? [], limits: keys.limits ?? [] })
      }
      cache.invalidate(subject)
    },

    /**
     * The subject's effective plan name (the default plan if unassigned).
     * @param {string} subject
     * @returns {Promise<string>}
     */
    async plan(subject) {
      return (await resolve(subject)).plan
    },

    /**
     * Whether a capability flag is granted to the subject. Throws on a feature
     * key outside the declared/derived universe, so typos surface instead of
     * silently returning false.
     * @param {string} subject
     * @param {string} feature
     * @returns {Promise<boolean>}
     */
    async can(subject, feature) {
      requireFeature(feature)
      return traced(tracer, "entitle.can", { "entitle.subject": subject, "entitle.feature": feature }, async () => {
        const eff = await resolve(subject)
        return eff.features[feature] === true
      })
    },

    /**
     * The numeric ceiling for a limit key, after overrides. Returns `null` only
     * when the limit is explicitly unlimited, and `0` for a known limit the
     * subject's plan does not grant - never silently unlimited. Throws on a key
     * outside the declared/derived universe. This is the static ceiling; it does
     * not read usage.
     * @param {string} subject
     * @param {string} key
     * @returns {Promise<number|null>}
     */
    limit(subject, key) {
      return resolveLimit(subject, key)
    },

    /**
     * Check live usage against the subject's limit. Resolves the ceiling, then
     * reads current usage from the meter for the metric of the same name. This is
     * the composition seam: entitle supplies the limit, meter supplies the usage.
     * Requires a `meter` to have been passed to `createEntitlements`.
     * @param {string} subject
     * @param {string} key - a limit key that is also a meter metric
     * @param {{ period?: any, range?: any }} [usageQuery] - forwarded to `meter.usage`
     * @returns {Promise<CheckResult>}
     */
    async check(subject, key, usageQuery = {}) {
      if (!meter) {
        throw new Error("check requires a `meter`; pass it to createEntitlements, or use limit() for the static ceiling")
      }
      return traced(tracer, "entitle.check", { "entitle.subject": subject, "entitle.feature": key }, async () => {
        const limit = await resolveLimit(subject, key)
        const usage = await meter.usage({ ...usageQuery, subject, metric: key })
        const used = usage.quantity
        const allowed = limit === null || used < limit
        return {
          allowed,
          used,
          remaining: limit === null ? null : Math.max(0, limit - used),
          limit,
          unit: usage.unit,
          feature: key,
        }
      })
    },

    /**
     * The subject's full effective entitlements, for a settings or billing page.
     * @param {string} subject
     * @returns {Promise<Effective>}
     */
    async describe(subject) {
      const eff = await resolve(subject)
      return { plan: eff.plan, features: { ...eff.features }, limits: { ...eff.limits } }
    },

    /** Release backing resources (driver connections). */
    close() {
      return driver.close?.()
    },
  }
}
