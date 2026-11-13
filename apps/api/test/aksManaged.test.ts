import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classify, familyOf, inReports, managedImages, newerTags, parseTracker, releasesAfter, scanCves, splitImage, summarizeVhd,
  trackerDistro, vhdReportPath,
} from "../src/services/aksManagedVulns.js";
import * as viewNs from "../../web/src/lib/aksManagedView.ts";
import type { AksManagedComponent } from "@aud/types";

const view = ((viewNs as unknown as { default?: typeof viewNs }).default ?? viewNs) as typeof viewNs;

// Shapes as the AKS Vulnerability Data API answers (Learn: security-vulnerability-api-reference) — public image names
const COREDNS = "mcr.microsoft.com/oss/v2/kubernetes/coredns";
const CNS = "mcr.microsoft.com/containernetworking/azure-cns";
const release = (tags: string[]) => ({ container_targets: [{ container_image: "x", active_container_images: { image_repo_tags: tags } }] });

test("managed images: Microsoft registry in managed namespaces only, one per image:tag with where it runs", () => {
  const pods = [
    { namespace: "kube-system", name: "coredns-1", labels: {}, mcr: [{ container: "coredns", image: `${COREDNS}:v1.14.7-2` }] },
    { namespace: "kube-system", name: "coredns-2", labels: {}, mcr: [{ container: "coredns", image: `${COREDNS}:v1.14.7-2` }] },
    { namespace: "app", name: "web", labels: {}, mcr: [{ container: "web", image: "mcr.microsoft.com/dotnet/aspnet:8.0" }] },
    { namespace: "azure-alb-system", name: "alb", labels: {}, mcr: [{ container: "alb", image: "mcr.microsoft.com/application-lb/images/alb-controller:1.10.32" }] },
  ];
  const r = managedImages(pods);
  assert.deepEqual(r.map((x) => `${x.image.split("/").at(-1)}:${x.tag}`), ["alb-controller:1.10.32", "coredns:v1.14.7-2"], "an app's own MCR base image is not a managed part");
  assert.equal(r[1]!.where.get("kube-system")!.pods, 2);
  assert.deepEqual(splitImage(`${COREDNS}:v1@sha256:abc`), [COREDNS, "v1"]);
  assert.equal(splitImage("registry:5000/x"), null, "a port is not a tag");
});

test("compare: newer tags newest first; ours newer than every report = newest known; gone = fixed, kept = Microsoft unfixed", () => {
  const reports = [release([`${COREDNS}:v1.14.7-2`, `${COREDNS}:v1.14.7-6`]), release([`${COREDNS}:v1.14.7-7`, `${CNS}:v1.9.3-4`])];
  assert.deepEqual(newerTags(COREDNS, "v1.14.7-2", reports), ["v1.14.7-7", "v1.14.7-6"]);
  assert.deepEqual(newerTags(COREDNS, "v1.14.7-9", reports), [], "an add-on build newer than the reports");
  assert.equal(inReports(CNS, reports), true);
  const s = classify(["CVE-1", "CVE-2", "CVE-3"], ["CVE-2"], false);
  assert.deepEqual([...s], [["CVE-1", "fixedInLatest"], ["CVE-2", "pendingMs"], ["CVE-3", "fixedInLatest"]]);
  assert.deepEqual([...classify(["CVE-1"], null, false)], [["CVE-1", "unknown"]], "no scan of a newer tag — never guessed");
  assert.deepEqual([...classify(["CVE-1"], null, true)], [["CVE-1", "pendingMs"]], "ours is the newest — nothing newer fixes it");
  assert.deepEqual(scanCves({ active_cves: [{ scanner: { name: "trivy" }, cves: [{ id: "CVE-2" }, { id: "CVE-1" }] }, { cves: [{ id: "CVE-1" }] }] }), ["CVE-1", "CVE-2"]);
  assert.throws(() => scanCves({}), /unexpected_shape/);
});

test("families: ama-logs · ama-metrics · networking · CSI · Defender · Kubernetes, release notes link", () => {
  assert.equal(familyOf("mcr.microsoft.com/azuremonitor/containerinsights/ciprod").family, "amaLogs");
  assert.equal(familyOf("mcr.microsoft.com/azuremonitor/containerinsights/ciprod/prometheus-collector/images").family, "amaMetrics");
  assert.equal(familyOf("mcr.microsoft.com/oss/v2/cilium/cilium-distroless").family, "networking");
  assert.equal(familyOf(CNS).family, "networking");
  assert.equal(familyOf("mcr.microsoft.com/oss/v2/kubernetes-csi/azurefile-csi").family, "csi");
  assert.equal(familyOf("mcr.microsoft.com/azuredefender/stable/pod-collector").family, "defender");
  assert.equal(familyOf(COREDNS).family, "kubernetes");
  assert.match(familyOf(CNS).notes, /^https:\/\/github\.com\/Azure\/azure-container-networking/);
});

test("node image label → VHD report path; OS packages summarized, the kernel as one row", () => {
  assert.equal(vhdReportPath("AKSUbuntu-2404gen2containerd-202610.23.0"), "AKSUbuntu-gen2-2404containerd/202610.23.0");
  assert.equal(vhdReportPath("AKSUbuntu-2204containerd-202610.23.0"), "AKSUbuntu-gen1-2204containerd/202610.23.0");
  assert.equal(vhdReportPath("AKSUbuntu-2004gen2fipscontainerd-202610.23.0"), "AKSUbuntu-gen2-2004fipscontainerd/202610.23.0");
  assert.equal(vhdReportPath("AKSAzureLinux-V3gen2-202610.23.0"), "AKSAzureLinuxV3-gen2/202610.23.0");
  assert.equal(vhdReportPath("AKSAzureLinux-V2gen2-202512.06.0"), "AKSAzureLinux-gen2/202512.06.0");
  assert.equal(vhdReportPath("AKSWindows-2022-containerd-20348.1.0"), null);
  assert.equal(trackerDistro("AKSUbuntu-gen2-2404containerd/202610.23.0"), "ubuntu 24.04");
  assert.equal(trackerDistro("AKSAzureLinuxV3-gen2/202610.23.0"), "azure linux");
  const s = summarizeVhd({ os_package_targets: [
    { name: "linux-image-6.8.0-1071-azure", version: "6.8.0-1071.79", active_cves: [{ id: "CVE-K1" }, { id: "CVE-K2" }] },
    { name: "linux-modules-6.8.0-1071-azure", version: "6.8.0-1071.79", active_cves: [{ id: "CVE-K1" }, { id: "CVE-K2" }] },
    { name: "binutils", version: "2.42", active_cves: [{ id: "CVE-B1" }] },
    { name: "bash", version: "5.2", active_cves: [] },
  ] });
  assert.deepEqual({ packages: s.packages, withCves: s.withCves, cves: s.cves, kernelCves: s.kernelCves }, { packages: 4, withCves: 3, cves: 3, kernelCves: 2 });
  assert.deepEqual(s.top.map((x) => x.name), ["linux (kernel)", "binutils"]);
});

test("release tracker: the region's AKS release now and before; newer releases not here yet", () => {
  const f = parseTracker({ Sections: {
    RP: { Components: { "Resource Provider": { RegionalStatuses: { Asia: [
      { RegionName: "Korea Central", Current: { Version: "v20260925", ReleaseDate: "2026-10-09T07:01:18Z", ReleaseNote: "https://github.com/Azure/AKS/releases/tag/2026-09-25" }, Recent: [{ Version: "v20260904", ReleaseDate: "2026-09-22T00:00:00Z" }], InProgress: false },
    ] } } } },
    UbuntuImage: { Components: { "Ubuntu 22.04": { RegionalStatuses: { Asia: [{ RegionName: "Korea Central", Current: { Version: "202610.23.0" } }] } } } },
  } });
  const kr = f.rp.get("koreacentral")!;
  assert.equal(kr.current, "v20260925");
  assert.deepEqual(kr.recent.map((r) => r.version), ["v20260904"]);
  assert.equal(f.images.get("ubuntu 22.04")!.get("koreacentral"), "202610.23.0");
  assert.deepEqual(releasesAfter(["v20260904", "v20260925", "v20261011", "v20261025"], "v20260925"), ["v20261011", "v20261025"]);
  assert.throws(() => parseTracker({}), /unexpected_shape/);
});

test("view: families worst first (exploited, then Microsoft-unfixed); compare kinds", () => {
  const comp = (family: AksManagedComponent["family"], cves: AksManagedComponent["cves"], latest: AksManagedComponent["latest"] = null): AksManagedComponent =>
    ({ family, image: `mcr.microsoft.com/x/${family}`, tag: "1", where: [], scan: "scanned", cves, latest, notes: "" });
  const cve = (status: "fixedInLatest" | "pendingMs" | "unknown", kev = false) => ({ id: `CVE-${status}-${kev}`, status, kev, severity: null, score: null });
  const g = view.groupByFamily([
    comp("csi", [cve("fixedInLatest"), cve("fixedInLatest")]),
    comp("networking", [cve("pendingMs")]),
    comp("kubernetes", [cve("unknown", true)]),
  ]);
  assert.deepEqual(g.map((x) => x.family), ["kubernetes", "networking", "csi"]);
  assert.equal(g[0]!.counts.kev, 1);
  assert.equal(view.compareKind(comp("csi", [], { tag: "2", same: false, scan: "scanned", cves: 0 })), "newer");
  assert.equal(view.compareKind(comp("csi", [], { tag: "2", same: false, scan: "notScanned", cves: null })), "newerUnscanned");
  assert.equal(view.compareKind(comp("csi", [], { tag: "1", same: true, scan: "scanned", cves: 0 })), "same");
  assert.equal(view.compareKind(comp("csi", [])), "none");
  assert.equal(view.shortImage(COREDNS), "kubernetes/coredns");
});

test("managed parts: a digest-pinned pod (status image = bare sha256) is found by its imageID", async () => {
  const { mcrImages } = await import("../src/services/k8sPolicyCollector.js");
  const D = "sha256:" + "a".repeat(64);
  assert.deepEqual(mcrImages([
    { name: "a", image: D, imageID: `mcr.microsoft.com/oss/kubernetes/coredns@${D}` },
    { name: "b", image: "mcr.microsoft.com/oss/kubernetes/coredns:v1.12.1", imageID: `mcr.microsoft.com/oss/kubernetes/coredns@${D}` },
    { name: "c", image: D, imageID: `myreg1.azurecr.io/team/app@${D}` },
    { name: "d", image: D },
  ]).mcr, [
    { container: "a", image: "mcr.microsoft.com/oss/kubernetes/coredns", digest: D },
    { container: "b", image: "mcr.microsoft.com/oss/kubernetes/coredns:v1.12.1", digest: D },
  ]);
});
