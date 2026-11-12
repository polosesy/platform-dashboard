// Push an OCI image layout directory (from `docker save`, extracted) to a registry with the v2 API — the step crane
// did. Usage: node oci-push.mjs <layout-dir> <registry-host> <repo> <tag>   (ACR refresh token on stdin)
import fs from "node:fs";
import path from "node:path";

const [dir, host, repo, tag] = process.argv.slice(2);
const refresh = fs.readFileSync(0, "utf8").trim();
if (!dir || !host || !repo || !tag || !refresh) throw new Error("usage: node oci-push.mjs <dir> <host> <repo> <tag> < token");

const tokRes = await fetch(`https://${host}/oauth2/token`, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", service: host, scope: `repository:${repo}:pull,push`, refresh_token: refresh }),
});
if (!tokRes.ok) throw new Error(`token ${tokRes.status}`);
const auth = { Authorization: `Bearer ${(await tokRes.json()).access_token}` };
const blobPath = (digest) => path.join(dir, "blobs", ...digest.split(":"));

const index = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
let desc = index.manifests[0];
let manifestRaw = fs.readFileSync(blobPath(desc.digest));
let manifest = JSON.parse(manifestRaw);
// docker save may wrap the image manifest in an index — follow it to the linux/amd64 (or only) manifest
if (manifest.manifests) {
  desc = manifest.manifests.find((m) => !m.platform || (m.platform.os === "linux" && m.platform.architecture === "amd64")) ?? manifest.manifests[0];
  manifestRaw = fs.readFileSync(blobPath(desc.digest));
  manifest = JSON.parse(manifestRaw);
}

async function pushBlob(d) {
  const head = await fetch(`https://${host}/v2/${repo}/blobs/${d.digest}`, { method: "HEAD", headers: auth });
  if (head.ok) return "exists";
  const start = await fetch(`https://${host}/v2/${repo}/blobs/uploads/`, { method: "POST", headers: auth });
  if (start.status !== 202) throw new Error(`upload start ${start.status}`);
  const loc = new URL(start.headers.get("location"), `https://${host}`);
  loc.searchParams.set("digest", d.digest);
  const file = blobPath(d.digest);
  const put = await fetch(loc, {
    method: "PUT", headers: { ...auth, "content-type": "application/octet-stream", "content-length": String(fs.statSync(file).size) },
    body: fs.createReadStream(file), duplex: "half",
  });
  if (put.status !== 201) throw new Error(`upload ${d.digest.slice(0, 19)} ${put.status} ${await put.text()}`);
  return "uploaded";
}

for (const d of [manifest.config, ...manifest.layers]) console.log(`${d.digest.slice(0, 19)}… ${(d.size / 1e6).toFixed(1)}MB ${await pushBlob(d)}`);
const put = await fetch(`https://${host}/v2/${repo}/manifests/${tag}`, {
  method: "PUT", headers: { ...auth, "content-type": manifest.mediaType ?? desc.mediaType }, body: manifestRaw,
});
if (put.status !== 201) throw new Error(`manifest ${put.status} ${await put.text()}`);
console.log(`DIGEST ${put.headers.get("docker-content-digest")}`);
