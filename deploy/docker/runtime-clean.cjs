// Runtime base clean-up (Dockerfile stage `runtime-base`, run as root with node — a hardened runtime has no shell).
// The stage is then copied into an empty image as ONE layer: a file deleted in a later layer still sits in the base
// layer underneath, and image scanners read every layer (2026-11-09 Defender: npm 11.19.1's minimatch · brace-expansion
// · glob · ip-address · undici · postcss-selector-parser kept showing after the old in-place delete).
//
//  1. the package managers the Node image ships (npm · npx · corepack · yarn) — nothing here ever installs packages
//  2. Debian only (apt-get present): pending security updates (the image tag lags the security archive — apt 2.6.2,
//     tzdata on 2026-11-09), then apt itself (2026-11-09 Defender: apt 2.6.1 High) — the running image never installs
//  3. itself
// A failed step fails the build: an image that silently kept them would pass review and fail the scan.
"use strict";
const fs = require("fs");
const { spawnSync } = require("child_process");

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status ?? r.signal}`);
};

const managers = [
  "/usr/local/lib/node_modules", "/usr/local/bin/npm", "/usr/local/bin/npx", "/usr/local/bin/corepack",
  "/usr/local/bin/yarn", "/usr/local/bin/yarnpkg",
  ...(fs.existsSync("/opt") ? fs.readdirSync("/opt").filter((d) => d.startsWith("yarn")).map((d) => `/opt/${d}`) : []),
];
for (const p of managers) fs.rmSync(p, { recursive: true, force: true });

if (fs.existsSync("/usr/bin/apt-get")) {
  run("apt-get", ["update", "-q"]);
  run("apt-get", ["-y", "-q", "--no-install-recommends", "-o", "Dpkg::Options::=--force-confold", "upgrade"]);
  // libapt-pkg6.0 is apt's own library (same source package, same CVEs) and nothing else needs it
  run("dpkg", ["--purge", "apt", "libapt-pkg6.0"]);
  for (const p of ["/var/lib/apt", "/var/cache/apt", "/etc/apt", "/var/log/apt"]) fs.rmSync(p, { recursive: true, force: true });
}

fs.rmSync(__filename, { force: true });
const left = [...managers, "/usr/bin/apt", "/usr/bin/apt-get"].filter((p) => fs.existsSync(p));
if (left.length) {
  console.error(`runtime-clean: still present: ${left.join(", ")}`);
  process.exit(1);
}
