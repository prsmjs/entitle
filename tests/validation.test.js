import { describe, it, expect } from "vitest"
import { createEntitlements } from "../src/index.js"
import { memoryDriver } from "../src/memoryDriver.js"

const make = (opts) => createEntitlements({ driver: memoryDriver(), ...opts })

describe("createEntitlements validation", () => {
  it("requires a non-empty plans catalog and a valid defaultPlan", () => {
    expect(() => make({ plans: {}, defaultPlan: "free" })).toThrow(/non-empty `plans`/)
    expect(() => make({ plans: { free: {} }, defaultPlan: "pro" })).toThrow(/defaultPlan/)
  })

  it("type-checks plan values at construction", () => {
    expect(() => make({ plans: { free: { features: { sso: "yes" } } }, defaultPlan: "free" }))
      .toThrow(/must be a boolean/)
    expect(() => make({ plans: { free: { limits: { tokens: "1000" } } }, defaultPlan: "free" }))
      .toThrow(/finite number or null/)
    expect(() => make({ plans: { free: { limits: { tokens: -1 } } }, defaultPlan: "free" }))
      .toThrow(/must not be negative/)
  })

  it("rejects plans that reference an undeclared feature or limit", () => {
    expect(() => make({
      plans: { free: { features: { sso: true } } },
      defaultPlan: "free",
      features: ["api"],
    })).toThrow(/undeclared feature "sso"/)

    expect(() => make({
      plans: { free: { limits: { tokens: 100 } } },
      defaultPlan: "free",
      limits: ["seats"],
    })).toThrow(/undeclared limit "tokens"/)
  })

  it("accepts a plan that uses a subset of the declared catalog", () => {
    expect(() => make({
      plans: { free: { features: { api: true }, limits: { tokens: 100 } } },
      defaultPlan: "free",
      features: ["api", "sso"],
      limits: ["tokens", "seats"],
    })).not.toThrow()
  })
})
