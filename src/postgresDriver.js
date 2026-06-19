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

    async subjects({ limit }) {
      const r = await pool.query(
        `select subject,
           bool_or(src = 'a') as assigned,
           bool_or(src = 'o') as overridden,
           max(updated_at) as last_at
         from (
           select subject, updated_at, 'a' as src from ${assignments}
           union all
           select subject, updated_at, 'o' as src from ${overrides}
         ) u
         group by subject order by last_at desc, subject asc limit $1`,
        [limit],
      )
      return r.rows.map((row) => ({
        subject: row.subject,
        assigned: row.assigned,
        overridden: row.overridden,
        lastConfiguredAt: row.last_at,
      }))
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

    async mergeOverride(subject, delta) {
      await pool.query(
        `insert into ${overrides} (subject, data)
         values ($1, jsonb_build_object('features', $2::jsonb, 'limits', $3::jsonb))
         on conflict (subject) do update set
           data = jsonb_build_object(
             'features', coalesce(${overrides}.data -> 'features', '{}'::jsonb) || (excluded.data -> 'features'),
             'limits',   coalesce(${overrides}.data -> 'limits',   '{}'::jsonb) || (excluded.data -> 'limits')
           ),
           updated_at = now()`,
        [subject, JSON.stringify(delta.features ?? {}), JSON.stringify(delta.limits ?? {})],
      )
    },

    async removeOverrideKeys(subject, keys) {
      await pool.query(
        `update ${overrides} set
           data = jsonb_build_object(
             'features', coalesce(data -> 'features', '{}'::jsonb) - $2::text[],
             'limits',   coalesce(data -> 'limits',   '{}'::jsonb) - $3::text[]
           ),
           updated_at = now()
         where subject = $1`,
        [subject, keys.features ?? [], keys.limits ?? []],
      )
    },

    async clearOverride(subject) {
      await pool.query(`delete from ${overrides} where subject = $1`, [subject])
    },

    async close() {},
  }
}
