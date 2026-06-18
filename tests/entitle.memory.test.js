import { runEntitleSuite } from "./suite.js"
import { memoryDriver } from "../src/memoryDriver.js"

runEntitleSuite("entitle (memory)", async () => memoryDriver())
