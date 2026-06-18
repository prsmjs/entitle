import { describe, afterAll } from "vitest"
import pg from "pg"
import { runEntitleSuite } from "./suite.js"
import { postgresDriver } from "../src/postgresDriver.js"

const url = process.env.ENTITLE_TEST_POSTGRES_URL

if (!url) {
  describe.skip("entitle (postgres) - set ENTITLE_TEST_POSTGRES_URL to run", () => {})
} else {
  const pool = new pg.Pool({ connectionString: url })
  const prefix = "entitle_test"

  afterAll(async () => {
    await pool.query(`drop table if exists ${prefix}_assignments, ${prefix}_overrides`)
    await pool.end()
  })

  runEntitleSuite("entitle (postgres)", async () => {
    const driver = postgresDriver({ pool, prefix })
    await driver.setup()
    await pool.query(`truncate ${prefix}_assignments, ${prefix}_overrides`)
    return driver
  })
}
