/**
 * @typedef {Object} PostgresDriverOptions
 * @property {import("pg").Pool} pool - a `pg` Pool
 * @property {string} [prefix] - table name prefix (default `"entitle"`), for keeping several resolvers in one database
 */

/**
 * Durable postgres entitlements driver. Two tables: plan assignments and
 * per-subject overrides. Both are keyed by subject and read live on resolution.
 *
 * @param {PostgresDriverOptions} options
 * @returns {object} a driver for `createEntitlements({ driver })`
 */
export function postgresDriver(options = {}) {
  const { pool, prefix = "entitle" } = options
  if (!pool) throw new Error("postgresDriver requires a `pool`")

  const assignments = `${prefix}_assignments`
  const overrides = `${prefix}_overrides`

  return {
    async setup() {
      await pool.query(`
        create table if not exists ${assignments} (
          subject text primary key,
          plan text not null,
          updated_at timestamptz not null default now()
        );
        create table if not exists ${overrides} (
          subject text primary key,
          data jsonb not null,
          updated_at timestamptz not null default now()
        );
      `)
    },

    async getState(subject) {
      const r = await pool.query(
        `select
           (select plan from ${assignments} where subject = $1) as plan,
           (select data from ${overrides} where subject = $1) as override`,
        [subject],
      )
      return { plan: r.rows[0].plan ?? null, override: r.rows[0].override ?? null }
    },

    async assign(subject, plan) {
      await pool.query(
        `insert into ${assignments} (subject, plan) values ($1, $2)
         on conflict (subject) do update set plan = excluded.plan, updated_at = now()`,
        [subject, plan],
      )
    },

    async unassign(subject) {
      await pool.query(`delete from ${assignments} where subject = $1`, [subject])
    },

    async setOverride(subject, data) {
      await pool.query(
        `insert into ${overrides} (subject, data) values ($1, $2)
         on conflict (subject) do update set data = excluded.data, updated_at = now()`,
        [subject, JSON.stringify(data)],
      )
    },

    async clearOverride(subject) {
      await pool.query(`delete from ${overrides} where subject = $1`, [subject])
    },

    async close() {},
  }
}
