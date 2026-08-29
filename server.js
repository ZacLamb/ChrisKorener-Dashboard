import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import cron from "node-cron";

import conversationsRouter from "./src/routes/conversations.js";
import syncRouter from "./src/routes/sync.js";
import reportRouter from "./src/routes/report.js";
import analyticsRouter from "./src/routes/analytics.js";
import { runSync } from "./src/sync.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

// --- Basic auth in front of everything (dashboard has full send access) ---
const USER = process.env.DASHBOARD_USER;
const PASS = process.env.DASHBOARD_PASS;
if (USER && PASS) {
  app.use((req, res, next) => {
    const header = req.headers.authorization || "";
    const [scheme, encoded] = header.split(" ");
    if (scheme === "Basic" && encoded) {
      const [u, p] = Buffer.from(encoded, "base64").toString().split(":");
      if (u === USER && p === PASS) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="GHL Dashboard"');
    res.status(401).send("Authentication required");
  });
}

app.use("/api/conversations", conversationsRouter);
app.use("/api/sync", syncRouter);
app.use("/api/report", reportRouter);
app.use("/api/analytics", analyticsRouter);

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GHL dashboard running on port ${PORT}`);
});

if (process.env.AUTO_SYNC === "true") {
  const schedule = process.env.AUTO_SYNC_CRON || "*/5 * * * *";
  console.log(`Auto-sync enabled on schedule: ${schedule}`);
  cron.schedule(schedule, async () => {
    try {
      const result = await runSync({ full: false });
      console.log(`Auto-sync done: ${result.convosSynced} conversations, ${result.messagesSynced} new messages`);
    } catch (err) {
      console.error("Auto-sync error:", err.message);
    }
  });
}
