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

    async setOverride(subject, data) {
      overrides.set(subject, data)
    },

    async clearOverride(subject) {
      overrides.delete(subject)
    },

    async close() {},
  }
}
