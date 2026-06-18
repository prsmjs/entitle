import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createEntitlements } from "../src/index.js"

export const PLANS = {
  free: { features: { api: true, sso: false, export: false }, limits: { tokens: 1000, seats: 1 } },
  pro: { features: { api: true, sso: true, export: true }, limits: { tokens: 100_000, seats: 10 } },
  enterprise: { features: { api: true, sso: true, export: true }, limits: { tokens: null, seats: null } },
}

// `projects` is declared but no plan grants it, to exercise the known-but-unset case
export const FEATURES = ["api", "sso", "export"]
export const LIMITS = ["tokens", "seats", "projects"]

function stubMeter() {
  const usage = new Map()
  return {
    set(subject, metric, quantity) { usage.set(`${subject}:${metric}`, quantity) },
    async usage({ subject, metric }) {
      return { quantity: usage.get(`${subject}:${metric}`) ?? 0, unit: "u", metric }
    },
  }
}

/**
 * Behavioral contract every driver must satisfy.
 * @param {string} label
 * @param {() => Promise<object>} makeDriver - returns a fresh, empty driver
 */
export function runEntitleSuite(label, makeDriver) {
  describe(label, () => {
    let entitlements, meter

    beforeEach(async () => {
      const driver = await makeDriver()
      meter = stubMeter()
      entitlements = createEntitlements({ driver, plans: PLANS, defaultPlan: "free", features: FEATURES, limits: LIMITS, meter })
      await entitlements.setup()
    })

    afterEach(async () => {
      await entitlements.close()
    })

    it("falls back to the default plan when unassigned", async () => {
      expect(await entitlements.plan("a")).toBe("free")
      expect(await entitlements.can("a", "api")).toBe(true)
      expect(await entitlements.can("a", "sso")).toBe(false)
      expect(await entitlements.limit("a", "tokens")).toBe(1000)
    })

    it("reflects an assignment immediately (cache invalidates on write)", async () => {
      expect(await entitlements.limit("a", "tokens")).toBe(1000) // warms the cache
      await entitlements.assign("a", "pro")
      expect(await entitlements.plan("a")).toBe("pro")
      expect(await entitlements.can("a", "sso")).toBe(true)
      expect(await entitlements.limit("a", "tokens")).toBe(100_000)
    })

    it("can() is false for an ungranted feature", async () => {
      await entitlements.assign("a", "free")
      expect(await entitlements.can("a", "export")).toBe(false)
    })

    it("can() and limit() throw on a key outside the catalog (typo protection)", async () => {
      await expect(entitlements.can("a", "nonexistent")).rejects.toThrow(/unknown feature/)
      await expect(entitlements.limit("a", "storage")).rejects.toThrow(/unknown limit/)
    })

    it("limit() is null only for explicit unlimited, and 0 for a known-but-unset limit", async () => {
      await entitlements.assign("a", "enterprise")
      expect(await entitlements.limit("a", "tokens")).toBe(null) // explicit unlimited
      expect(await entitlements.limit("a", "projects")).toBe(0) // declared, granted by no plan -> deny, never unlimited
    })

    it("unassign reverts a subject to the default plan", async () => {
      await entitlements.assign("a", "pro")
      expect(await entitlements.plan("a")).toBe("pro")
      await entitlements.unassign("a")
      expect(await entitlements.plan("a")).toBe("free")
    })

    it("override merges over the plan and wins", async () => {
      await entitlements.assign("a", "free")
      await entitlements.override("a", { features: { sso: true }, limits: { seats: 50 } })
      expect(await entitlements.can("a", "sso")).toBe(true)
      expect(await entitlements.can("a", "api")).toBe(true) // untouched plan feature
      expect(await entitlements.limit("a", "seats")).toBe(50)
      expect(await entitlements.limit("a", "tokens")).toBe(1000) // untouched plan limit
    })

    it("override accumulates across calls instead of replacing", async () => {
      await entitlements.assign("a", "free")
      await entitlements.override("a", { features: { sso: true } })
      await entitlements.override("a", { limits: { seats: 50 } })
      expect(await entitlements.can("a", "sso")).toBe(true)
      expect(await entitlements.limit("a", "seats")).toBe(50)
    })

    it("override updates a key without dropping the others", async () => {
      await entitlements.assign("a", "free")
      await entitlements.override("a", { limits: { seats: 50 } })
      await entitlements.override("a", { features: { sso: true } })
      await entitlements.override("a", { limits: { seats: 100 } })
      expect(await entitlements.limit("a", "seats")).toBe(100)
      expect(await entitlements.can("a", "sso")).toBe(true)
    })

    it("clearOverride reverts to the plan", async () => {
      await entitlements.assign("a", "free")
      await entitlements.override("a", { features: { sso: true } })
      expect(await entitlements.can("a", "sso")).toBe(true)
      await entitlements.clearOverride("a")
      expect(await entitlements.can("a", "sso")).toBe(false)
    })

    it("clearOverride with keys removes only those entries", async () => {
      await entitlements.assign("a", "free")
      await entitlements.override("a", { features: { sso: true }, limits: { seats: 50 } })
      await entitlements.clearOverride("a", { limits: ["seats"] })
      expect(await entitlements.can("a", "sso")).toBe(true) // kept
      expect(await entitlements.limit("a", "seats")).toBe(1) // reverted to plan
    })

    it("describe returns the full effective snapshot", async () => {
      await entitlements.assign("a", "pro")
      await entitlements.override("a", { limits: { seats: 25 } })
      const d = await entitlements.describe("a")
      expect(d.plan).toBe("pro")
      expect(d.features).toEqual({ api: true, sso: true, export: true })
      expect(d.limits).toEqual({ tokens: 100_000, seats: 25 })
    })

    it("check composes the resolved limit with live meter usage", async () => {
      await entitlements.assign("a", "free")
      meter.set("a", "tokens", 400)
      expect(await entitlements.check("a", "tokens")).toEqual({
        allowed: true, used: 400, remaining: 600, limit: 1000, unit: "u", feature: "tokens",
      })
      meter.set("a", "tokens", 1200)
      const over = await entitlements.check("a", "tokens")
      expect(over.allowed).toBe(false)
      expect(over.remaining).toBe(0)
    })

    it("check treats an unlimited plan as always allowed", async () => {
      await entitlements.assign("a", "enterprise")
      meter.set("a", "tokens", 9_999_999)
      const r = await entitlements.check("a", "tokens")
      expect(r.allowed).toBe(true)
      expect(r.limit).toBe(null)
      expect(r.remaining).toBe(null)
    })

    it("rejects assigning an unknown plan", async () => {
      await expect(entitlements.assign("a", "nope")).rejects.toThrow(/unknown plan/)
    })

    it("rejects malformed and unknown overrides", async () => {
      await expect(entitlements.override("a", { features: { sso: "yes" } })).rejects.toThrow(/boolean/)
      await expect(entitlements.override("a", { limits: { seats: "lots" } })).rejects.toThrow(/finite number or null/)
      await expect(entitlements.override("a", { features: { flying: true } })).rejects.toThrow(/unknown feature/)
      await expect(entitlements.override("a", { limits: { storage: 5 } })).rejects.toThrow(/unknown limit/)
    })

    it("check without a meter throws", async () => {
      const noMeter = createEntitlements({ driver: await makeDriver(), plans: PLANS, defaultPlan: "free", features: FEATURES, limits: LIMITS })
      await noMeter.setup()
      await expect(noMeter.check("a", "tokens")).rejects.toThrow(/requires a `meter`/)
      await noMeter.close()
    })
  })
}
