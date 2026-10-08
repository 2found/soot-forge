// Local Cloudflare API stub for fixtures. Speaks just enough of the REST v4
// + R2 S3 surface for runner smoke tests: workers scripts, d1 databases,
// dns records, R2 object PUT/DELETE/GET.
// Run: node serve.mjs  (listens on :8787)
import http from "node:http";

const state = {
  workers: new Map(),
  d1: new Map(),
  dns: new Map(),
  r2: new Map(), // bucket objects
};
let seq = 0;
const id = (p) => p + (++seq).toString(16).padStart(8, "0");

function envelope(res, result, code = 200) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify({ success: code < 300, result, errors: [] }));
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    // R2 S3 surface: /<bucket>/<key> with SigV4 headers — stub accepts any sig.
    if (req.headers["x-amz-date"] || u.pathname.startsWith("/bucket/")) {
      const key = decodeURIComponent(u.pathname.replace(/^\/bucket\/?/, ""));
      if (req.method === "PUT") { state.r2.set(key, body); res.writeHead(200); res.end(); return; }
      if (req.method === "DELETE") { state.r2.delete(key); res.writeHead(204); res.end(); return; }
      if (req.method === "GET" && u.searchParams.get("list-type")) {
        const objs = [...state.r2.entries()].map(([k, v]) =>
          `<Contents><Key>${k}</Key><Size>${v.length}</Size><ETag>"e"</ETag></Contents>`).join("");
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(`<ListBucketResult>${objs}</ListBucketResult>`); return;
      }
      if (req.method === "GET") {
        const v = state.r2.get(key);
        if (v) { res.writeHead(200); res.end(v); } else { res.writeHead(404); res.end(); }
        return;
      }
    }
    // REST v4 surface
    const p = u.pathname;
    if (req.method === "PUT" && /\/workers\/scripts\/[^/]+$/.test(p)) {
      state.workers.set(p.split("/").pop(), body.length); envelope(res, { id: p.split("/").pop() }); return;
    }
    if (req.method === "POST" && /\/workers\/scripts\/[^/]+\/subdomain$/.test(p)) { envelope(res, {}); return; }
    if (req.method === "DELETE" && /\/workers\/scripts\/[^/]+$/.test(p)) {
      state.workers.delete(p.split("/").pop()); envelope(res, {}); return;
    }
    if (req.method === "GET" && /\/workers\/scripts$/.test(p)) {
      envelope(res, [...state.workers.keys()].map((k) => ({ id: k }))); return;
    }
    if (req.method === "POST" && /\/d1\/database$/.test(p)) {
      const name = JSON.parse(body || "{}").name;
      const uuid = "00000000-0000-4000-8000-" + seq.toString(16).padStart(12, "0");
      state.d1.set(uuid, name); envelope(res, { uuid, name }); return;
    }
    if (req.method === "POST" && /\/d1\/database\/[^/]+\/query$/.test(p)) {
      const sql = (JSON.parse(body || "{}").sql || "");
      const rows = /^select/i.test(sql.trim()) ? [{ ok: 1 }] : [];
      envelope(res, [{ results: rows, success: true }]); return;
    }
    if (req.method === "GET" && /\/d1\/database/.test(p)) {
      const name = u.searchParams.get("name");
      const list = [...state.d1.entries()].filter(([, n]) => !name || n === name)
        .map(([uuid, n]) => ({ uuid, name: n }));
      envelope(res, list); return;
    }
    if (req.method === "POST" && /\/zones\/[^/]+\/dns_records$/.test(p)) {
      const r = JSON.parse(body || "{}"); const rid = id("rec");
      state.dns.set(rid, r); envelope(res, { id: rid, ...r }); return;
    }
    if (req.method === "DELETE" && /\/dns_records\/[^/]+$/.test(p)) {
      state.dns.delete(p.split("/").pop()); envelope(res, {}); return;
    }
    if (req.method === "GET" && /\/dns_records/.test(p)) {
      envelope(res, [...state.dns.entries()].map(([rid, r]) => ({ id: rid, ...r }))); return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: false, errors: [{ message: "no stub route: " + req.method + " " + p }] }));
  });
});
server.listen(8787, "127.0.0.1", () => console.log("cf-stub on :8787"));
