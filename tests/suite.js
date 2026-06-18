import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createEntitlements } from "../src/index.js"

export const PLANS = {
  free: { features: { api: true, sso: false, export: false }, limits: { tokens: 1000, seats: 1 } },
  pro: { features: { api: true, sso: true, export: true }, limits: { tokens: 100_000, seats: 10 } },
  enterprise: { features: { api: true, sso: true, export: true }, limits: { tokens: null, seats: null } },
}

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
      entitlements = createEntitlements({ driver, plans: PLANS, defaultPlan: "free", meter })
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

    it("can() is false for ungranted and unknown features", async () => {
      await entitlements.assign("a", "free")
      expect(await entitlements.can("a", "export")).toBe(false)
      expect(await entitlements.can("a", "nonexistent")).toBe(false)
    })

    it("limit() returns null for unlimited and undeclared keys", async () => {
      await entitlements.assign("a", "enterprise")
      expect(await entitlements.limit("a", "tokens")).toBe(null)
      expect(await entitlements.limit("a", "undeclared")).toBe(null)
    })

    it("override merges over the plan and wins", async () => {
      await entitlements.assign("a", "free")
      await entitlements.override("a", { features: { sso: true }, limits: { seats: 50 } })
      expect(await entitlements.can("a", "sso")).toBe(true)
      expect(await entitlements.can("a", "api")).toBe(true) // untouched plan feature
      expect(await entitlements.limit("a", "seats")).toBe(50)
      expect(await entitlements.limit("a", "tokens")).toBe(1000) // untouched plan limit
    })

    it("clearOverride reverts to the plan", async () => {
      await entitlements.assign("a", "free")
      await entitlements.override("a", { features: { sso: true } })
      expect(await entitlements.can("a", "sso")).toBe(true)
      await entitlements.clearOverride("a")
      expect(await entitlements.can("a", "sso")).toBe(false)
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

    it("rejects malformed overrides", async () => {
      await expect(entitlements.override("a", { features: { sso: "yes" } })).rejects.toThrow(/boolean/)
      await expect(entitlements.override("a", { limits: { seats: "lots" } })).rejects.toThrow(/finite number or null/)
    })

    it("check without a meter throws", async () => {
      const noMeter = createEntitlements({ driver: await makeDriver(), plans: PLANS, defaultPlan: "free" })
      await noMeter.setup()
      await expect(noMeter.check("a", "tokens")).rejects.toThrow(/requires a `meter`/)
      await noMeter.close()
    })
  })
}
