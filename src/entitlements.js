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

function validatePlans(plans, defaultPlan) {
  if (!plans || typeof plans !== "object" || Object.keys(plans).length === 0) {
    throw new Error("createEntitlements requires a non-empty `plans` catalog")
  }
  for (const [name, plan] of Object.entries(plans)) {
    if (plan.features && typeof plan.features !== "object") throw new Error(`plan "${name}" features must be an object`)
    if (plan.limits && typeof plan.limits !== "object") throw new Error(`plan "${name}" limits must be an object`)
  }
  if (!defaultPlan || !plans[defaultPlan]) {
    throw new Error(`createEntitlements requires \`defaultPlan\` to be one of the declared plans: ${Object.keys(plans).join(", ")}`)
  }
}

function validateOverride(data) {
  if (!data || typeof data !== "object") throw new Error("override data must be an object with `features` and/or `limits`")
  for (const [k, v] of Object.entries(data.features ?? {})) {
    if (typeof v !== "boolean") throw new Error(`override feature "${k}" must be a boolean`)
  }
  for (const [k, v] of Object.entries(data.limits ?? {})) {
    if (v !== null && (typeof v !== "number" || !Number.isFinite(v))) throw new Error(`override limit "${k}" must be a finite number or null`)
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
  validatePlans(plans, defaultPlan)

  const catalog = { ...plans }
  const cache = createCache(ms(options.cacheTtl ?? "10s"))

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
      validateOverride(data)
      const current = (await driver.getState(subject))?.override ?? {}
      await driver.setOverride(subject, {
        features: { ...(current.features ?? {}), ...(data.features ?? {}) },
        limits: { ...(current.limits ?? {}), ...(data.limits ?? {}) },
      })
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
        cache.invalidate(subject)
        return
      }
      const current = (await driver.getState(subject))?.override
      if (current) {
        const features = { ...(current.features ?? {}) }
        const limits = { ...(current.limits ?? {}) }
        for (const k of keys.features ?? []) delete features[k]
        for (const k of keys.limits ?? []) delete limits[k]
        if (Object.keys(features).length === 0 && Object.keys(limits).length === 0) {
          await driver.clearOverride(subject)
        } else {
          await driver.setOverride(subject, { features, limits })
        }
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
     * Whether a capability flag is granted to the subject.
     * @param {string} subject
     * @param {string} feature
     * @returns {Promise<boolean>}
     */
    async can(subject, feature) {
      return traced(tracer, "entitle.can", { "entitle.subject": subject, "entitle.feature": feature }, async () => {
        const eff = await resolve(subject)
        return eff.features[feature] === true
      })
    },

    /**
     * The numeric ceiling for a limit key, after overrides. Returns `null` for an
     * unlimited or undeclared limit. This is the static ceiling; it does not read usage.
     * @param {string} subject
     * @param {string} key
     * @returns {Promise<number|null>}
     */
    async limit(subject, key) {
      const eff = await resolve(subject)
      return key in eff.limits ? eff.limits[key] : null
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
        const limit = await this.limit(subject, key)
        const usage = await meter.usage({ subject, metric: key, ...usageQuery })
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
