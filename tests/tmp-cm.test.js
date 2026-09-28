import { DatabaseSync } from "node:sqlite";
import { QoderExecutor } from "../open-sse/executors/qoder.js";
test("cmodel via executor binary account", async () => {
  const db = new DatabaseSync("/data/data/com.termux/files/usr/var/lib/9router/db/data.sqlite", { readOnly: true });
  const d = db.prepare("SELECT name, data FROM providerConnections WHERE provider='qoder' AND data LIKE '%019fde4b%' LIMIT 1").all();
  const j = JSON.parse(d[0].data);
  const creds = { accessToken: j.accessToken, refreshToken: j.refreshToken||"", displayName: d[0].name, email: j.email||"", providerSpecificData: j.providerSpecificData||{} };
  console.log("TOKEN", j.accessToken.slice(0,25), "| uid", j.providerSpecificData?.userId);
  const ex = new QoderExecutor();
  const body = { model: "qoder/cmodel", messages: [{role:"user", content:"reply OK"}], stream: true };
  const { response } = await ex.execute({ model: "qoder/cmodel", body, stream: true, credentials: creds, signal: new AbortController().signal, log: { info: ()=>{}, warn: ()=>{}, error: ()=>{} } });
  console.log("HTTP", response.status);
  const text = await response.text();
  console.log("BODY", text.slice(0, 300));
}, 90000);
