/**
 * In-memory entitlements driver. Mirrors the postgres driver's behavior so the
 * test suite runs without infrastructure. Not durable - state lives for the
 * lifetime of the process.
 *
 * @returns {object} a driver for `createEntitlements({ driver })`
 */
export function memoryDriver() {
  const assignments = new Map()
  const overrides = new Map()

  return {
    async setup() {},

    async getState(subject) {
      return {
        plan: assignments.get(subject) ?? null,
        override: overrides.get(subject) ?? null,
      }
    },

    async assign(subject, plan) {
      assignments.set(subject, plan)
    },

    async unassign(subject) {
      assignments.delete(subject)
    },

    async mergeOverride(subject, delta) {
      const current = overrides.get(subject) ?? { features: {}, limits: {} }
      overrides.set(subject, {
        features: { ...(current.features ?? {}), ...(delta.features ?? {}) },
        limits: { ...(current.limits ?? {}), ...(delta.limits ?? {}) },
      })
    },

    async removeOverrideKeys(subject, keys) {
      const current = overrides.get(subject)
      if (!current) return
      const features = { ...(current.features ?? {}) }
      const limits = { ...(current.limits ?? {}) }
      for (const k of keys.features ?? []) delete features[k]
      for (const k of keys.limits ?? []) delete limits[k]
      overrides.set(subject, { features, limits })
    },

    async clearOverride(subject) {
      overrides.delete(subject)
    },

    async close() {},
  }
}
