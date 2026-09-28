// One line through the logger, one through the bridged console.
import { getLogger } from "../../src/index.js";

getLogger().info({ queue: "google" }, "through the logger");
console.error(
  "[Worker google] Job failed",
  { jobId: "9", failedReason: "boom" },
  new TypeError("wrapped"),
);
