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
  const touched = new Map()

  const touch = (subject) => touched.set(subject, new Date())

  return {
    async setup() {},

    async getState(subject) {
      return {
        plan: assignments.get(subject) ?? null,
        override: overrides.get(subject) ?? null,
      }
    },

    async subjects({ limit }) {
      const subs = new Set([...assignments.keys(), ...overrides.keys()])
      return [...subs]
        .map((subject) => ({
          subject,
          assigned: assignments.has(subject),
          overridden: overrides.has(subject),
          lastConfiguredAt: touched.get(subject) ?? null,
        }))
        .sort((a, b) => (b.lastConfiguredAt?.getTime() ?? 0) - (a.lastConfiguredAt?.getTime() ?? 0) || (a.subject < b.subject ? -1 : 1))
        .slice(0, limit)
    },

    async assign(subject, plan) {
      assignments.set(subject, plan)
      touch(subject)
    },

    async unassign(subject) {
      assignments.delete(subject)
      touch(subject)
    },

    async mergeOverride(subject, delta) {
      const current = overrides.get(subject) ?? { features: {}, limits: {} }
      overrides.set(subject, {
        features: { ...(current.features ?? {}), ...(delta.features ?? {}) },
        limits: { ...(current.limits ?? {}), ...(delta.limits ?? {}) },
      })
      touch(subject)
    },

    async removeOverrideKeys(subject, keys) {
      const current = overrides.get(subject)
      if (!current) return
      const features = { ...(current.features ?? {}) }
      const limits = { ...(current.limits ?? {}) }
      for (const k of keys.features ?? []) delete features[k]
      for (const k of keys.limits ?? []) delete limits[k]
      overrides.set(subject, { features, limits })
      touch(subject)
    },

    async clearOverride(subject) {
      overrides.delete(subject)
      touch(subject)
    },

    async close() {},
  }
}
