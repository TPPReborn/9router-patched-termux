import { DatabaseSync } from "node:sqlite";
import { resolveQoderModels } from "../open-sse/services/qoderModels.js";
test("preflight resolve for all active qoder accounts", async () => {
  const db = new DatabaseSync("/data/data/com.termux/files/usr/var/lib/9router/db/data.sqlite", { readOnly: true });
  const conns = db.prepare("SELECT name, data FROM providerConnections WHERE provider='qoder' AND isActive=1").all();
  console.log("accounts:", conns.length);
  for (const c of conns) {
    const j = JSON.parse(c.data);
    const connObj = { accessToken: j.accessToken, providerSpecificData: j.providerSpecificData || {} };
    const r = await resolveQoderModels(connObj, {});
    const state = r ? (r.ok === false ? `FAIL:${r.status}` : `OK:${r.models?.length}`) : "NULL";
    console.log(" -", c.name.slice(0, 25), "=>", state);
  }
}, 120000);
