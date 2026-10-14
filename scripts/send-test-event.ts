import { sendEvents } from "../lib/newrelic.js";

await sendEvents([{ eventType: "TalonOneTest", message: "hello from talon-newrelic-pipeline", ok: true }]);
console.log("sent. Run: SELECT * FROM TalonOneTest SINCE 10 minutes ago");
