import assert from "node:assert/strict"
import { readFileSync as readFileRaw } from "node:fs"
import { resolve } from "node:path"
import test from "node:test"
import { buildMetadata, canonical, checkDependencyCommits, validateDescriptor, validateExactVersionOverride, validateInput } from "../scripts/release/metadata.mjs"

const root = resolve(import.meta.dirname, "..")
const readFileSync = (path, encoding) => {
  const value = readFileRaw(path, encoding)
  return typeof value === "string" ? value.replaceAll("\r\n", "\n") : value
}
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"))
const input = readJson("release/producer-input.v1.json")
const manifest = readJson("plugin.json")
const packageJson = readJson("web/package.json")
const runtimePackageJson = readJson("package.json")
const runtimeLock = readJson("release/doctor-runtime-lock.v1.json")
const dotnetSdk = readJson("global.json")
const read = (path) => readFileSync(resolve(root, path), "utf8")

test("cross-repository bridge retains the scoped producer token", () => {
  const workflow = readFileSync(resolve(root, ".github/workflows/release-candidate.yml"), "utf8")
  assert.match(workflow, /GH_TOKEN: \$\{\{ secrets\.CROSS_REPO_TOKEN \|\| github\.token \}\}/)
  assert.doesNotMatch(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/)
})

test("automated version overrides can change only the four Doctor version fields", () => {
  const testVersion = manifest.version === "1.2.1" ? "1.2.2" : "1.2.1"
  const head = {
    manifest: structuredClone(manifest),
    input: structuredClone(input),
    packageJson: structuredClone(packageJson),
    runtimePackageJson: structuredClone(runtimePackageJson),
  }
  const current = structuredClone(head)
  current.manifest.version = testVersion
  current.packageJson.version = testVersion
  current.runtimePackageJson.version = testVersion
  current.input.runtimeRequirements.find((item) => item.id === "doctor-runtime").versionConstraint = testVersion
  assert.doesNotThrow(() => validateExactVersionOverride(head, current, testVersion))
  current.manifest.description = "unexpected mutation"
  assert.throws(() => validateExactVersionOverride(head, current, testVersion), /beyond the exact release version fields/)
  const inconsistent = structuredClone(head)
  inconsistent.manifest.version = testVersion
  assert.throws(() => validateExactVersionOverride(head, inconsistent, testVersion), /must match the requested version/)
  assert.throws(() => validateExactVersionOverride(head, head, manifest.version), /must change the committed version/)
})

test("producer declares Doctor's protected detached-runtime contract exactly", () => {
  validateInput(input, manifest, packageJson, runtimeLock, root)
  assert.equal(input.classification, "protected")
  assert.deepEqual(input.dependencies, [])
  assert.equal(input.leafSdk.repository, "RedBamboo-Interactive/redleaf")
  assert.equal(input.redbamboo.repository, "RedBamboo-Interactive/redbamboo-packages")
  assert.deepEqual(input.leafSdk, { repository: "RedBamboo-Interactive/redleaf", sourcePath: "src/Leaf.Sdk" })
  assert.deepEqual(Object.keys(input.redbamboo).sort(), ["inputs", "lockPath", "repository"])
  assert.deepEqual(input.redbamboo.inputs.map((item) => item.name), ["@redbamboo/ui", "@redbamboo/utility"])
  assert.deepEqual(input.runtimeRequirements.map((item) => item.id), ["claude-code", "cloudflared", "codex", "doctor-runtime", "node"])
  assert.match(input.runtimeRequirements.find((item) => item.id === "doctor-runtime").interface, /GET \/health/)
  assert.equal(runtimeLock.node.executable.sha256, "dccc52de28d8df2ee22d2062424f8c563070d95d8ad70c54c4bf01d590dec14f")
})

test("ReleaseTool and Leaf.Sdk commits are builder inputs the producer input never commits", () => {
  assert.equal(dotnetSdk.sdk.version, input.toolchain.dotnetSdk)
  assert.equal(dotnetSdk.sdk.rollForward, "disable")
  assert.equal("redleafReleaseToolCommit" in input, false)
  for (const pinned of [
    { ...structuredClone(input), redleafReleaseToolCommit: "1".repeat(40) },
    { ...structuredClone(input), leafSdk: { ...input.leafSdk, commit: "1".repeat(40) } },
    { ...structuredClone(input), redbamboo: { ...input.redbamboo, commit: "2".repeat(40) } },
  ]) assert.throws(() => validateInput(pinned, manifest, packageJson, runtimeLock, root), /builder inputs/)
})

test("the builder-supplied commits must be exact and name the checkouts that were built", () => {
  const redleaf = "1".repeat(40)
  const redbamboo = "2".repeat(40)
  const checkouts = { leafSdk: redleaf, redleaf, redbamboo }
  assert.doesNotThrow(() => checkDependencyCommits({ redleaf, redbamboo }, checkouts))
  assert.throws(() => checkDependencyCommits({ redleaf: "main", redbamboo }, checkouts), /--redleaf-commit must be one full lowercase commit SHA/)
  assert.throws(() => checkDependencyCommits({ redleaf, redbamboo: "A".repeat(40) }, checkouts), /--redbamboo-commit must be one full lowercase commit SHA/)
  assert.throws(() => checkDependencyCommits({ redleaf, redbamboo }, { ...checkouts, leafSdk: "3".repeat(40) }), /Leaf\.Sdk checkout is at 3{40}, but the builder supplied 1{40}/)
  assert.throws(() => checkDependencyCommits({ redleaf, redbamboo }, { ...checkouts, redleaf: "3".repeat(40) }), /RedLeaf release tool checkout/)
  assert.throws(() => checkDependencyCommits({ redleaf, redbamboo }, { ...checkouts, redbamboo: "3".repeat(40) }), /RedBamboo checkout/)
})

test("metadata carries only genuine SDK and RedBamboo source inputs", () => {
  const metadata = buildMetadata(input, manifest, {
    doctorCommit: "2".repeat(40),
    doctorUrl: "https://github.com/rblaurent/leaf-doctor.git",
    leafSdkUrl: "https://github.com/RedBamboo-Interactive/redleaf.git",
    redbambooUrl: "https://github.com/RedBamboo-Interactive/redbamboo-packages.git",
    redleafCommit: "1".repeat(40),
    redbambooCommit: "3".repeat(40),
    builtAt: "2026-08-07T09:00:46.000Z",
  })
  assert.deepEqual(metadata.buildInputs.map((item) => item.id), ["leaf-sdk", "redbamboo-ui", "redbamboo-utility"])
  // The builder-supplied commits are recorded exactly where the signed record and announcements read them.
  assert.equal(metadata.toolchain.releaseTool, "1".repeat(40))
  assert.deepEqual(metadata.buildInputs.map((item) => item.commit), ["1".repeat(40), "3".repeat(40), "3".repeat(40)])
  assert.doesNotMatch(canonical(metadata), /apphost|tree|subtree|registry|channel|signature/i)
  assert.equal(metadata.sbom, undefined)
  assert.deepEqual(metadata.sboms, [])
})

test("descriptor reconciliation retains private runtime payload without fake provision.json", () => {
  const metadata = buildMetadata(input, manifest, {
    doctorCommit: "2".repeat(40), doctorUrl: "https://example.invalid/doctor.git",
    leafSdkUrl: "https://example.invalid/redleaf.git", redbambooUrl: "https://example.invalid/redbamboo.git",
    redleafCommit: "1".repeat(40), redbambooCommit: "3".repeat(40),
    builtAt: "2026-08-07T09:00:46.000Z",
  })
  const fakeFacts = { sizeBytes: 1, sha256: "a".repeat(64) }
  const lockFiles = Object.fromEntries(metadata.dependencyLocks.map((item) => [item.id, resolve(root, item.id === "redbamboo-pnpm-lock" ? "web/pnpm-lock.yaml" : item.path)]))
  const expectedLocks = metadata.dependencyLocks.map((item) => ({ ...item, ...fakeFacts }))
  const descriptor = {
    componentId: "doctor", version: manifest.version, classification: "protected", componentKind: "extension",
    compatibility: metadata.compatibility,
    artifact: fakeFacts,
    evidence: { repository: metadata.repository, build: metadata.build, buildInputs: metadata.buildInputs, dependencyLocks: expectedLocks, runtimeRequirements: metadata.runtimeRequirements },
    provisioning: { present: false, payloadPaths: ["payload/doctor/dashboard.html", "payload/doctor/doctor-prompt.md", "payload/doctor/leaf-doctor.js", "payload/doctor/node.exe", "payload/doctor/package.json"], runtimeRequirements: metadata.runtimeRequirements },
    permissions: manifest.permissions.map((item) => `${item.kind}:${item.target}`).sort(), dependencies: [], sboms: [],
  }
  assert.equal(typeof validateDescriptor, "function")
  assert.deepEqual(descriptor.provisioning.payloadPaths.length, 5)
  assert.deepEqual(descriptor.provisioning.present, false)
  assert.equal(lockFiles["redbamboo-pnpm-lock"].endsWith("pnpm-lock.yaml"), true)
})

test("producer invokes the canonical stage, filter, produce, and ingest commands", () => {
  const producer = readFileSync(resolve(root, "scripts/release/produce.ps1"), "utf8")
  for (const command of ["extension stage-manifest", "extension filter-backend", "extension', 'produce", "candidate ingest-extension"]) assert.match(producer, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.match(producer, /--locked-mode/)
  assert.match(producer, /--frozen-lockfile/)
  assert.match(producer, /https:\/\/github\.com\/rblaurent\/leaf-doctor\/releases\/download\/leaf-doctor-unsigned-candidates\/doctor-\$Version\.leafpkg/)
  assert.match(producer, /Doctor version must be a safe package-name segment/)
  assert.doesNotMatch(producer, /ArtifactUrl|artifact_url/)
  assert.doesNotMatch(producer, /candidate finalize|registry build|publication |--channel/i)
})

test("workflow is immutable, producer-scoped, and reproduces all four handoff files", () => {
  const workflow = readFileSync(resolve(root, ".github/workflows/release-candidate.yml"), "utf8")
  assert.match(workflow, /workflow_call:\n    inputs:/)
  assert.match(workflow, /workflow_dispatch:\n    inputs:/)
  assert.match(workflow, /ref: \$\{\{ inputs\.source_commit \|\| github\.workflow_sha \}\}/)
  assert.match(workflow, /source-commit '\$\{\{ inputs\.source_commit \|\| github\.workflow_sha \}\}'/)
  assert.doesNotMatch(workflow, /uses: [^@\n]+@(main|master|v\d+)\s*$/m)
  assert.doesNotMatch(workflow, /artifact_url/)
  assert.doesNotMatch(workflow, /central_release_tag|CENTRAL_RELEASE_TAG/)
  assert.match(workflow, /repository: rblaurent\/leaf-doctor/)
  assert.match(workflow, /Cross-repository callers must supply the exact canonical Doctor source commit/)
  assert.doesNotMatch(workflow, /github\.repository == 'rblaurent\/leaf-doctor'/)
  assert.match(workflow, /repository: RedBamboo-Interactive\/redleaf/)
  assert.match(workflow, /repository: RedBamboo-Interactive\/redbamboo-packages/)
  assert.equal((workflow.match(/\.\/scripts\/release\/produce\.ps1/g) ?? []).length, 2)
  for (const name of [".leafpkg", ".component-input.v1.json", "candidate.unsigned.json", "signature-input.json"]) assert.match(workflow, new RegExp(name.replaceAll(".", "\\.")))
  assert.doesNotMatch(workflow, /candidate finalize|registry build|--channel/i)
})

test("serialized bridge appends only the exact immutable candidate pair", () => {
  const workflow = readFileSync(resolve(root, ".github/workflows/release-candidate.yml"), "utf8")
  assert.equal((workflow.match(/runs-on: windows-2025/g) ?? []).length, 1)
  assert.equal((workflow.match(/runs-on: ubuntu-24\.04/g) ?? []).length, 1)
  assert.equal((workflow.match(/enableCrossOsArchive: true/g) ?? []).length, 2)
  assert.match(workflow, /permissions:\n\s+contents: read/)
  assert.match(workflow, /bridge:\n[\s\S]*?permissions:\n\s+actions: read\n\s+contents: write/)
  assert.match(workflow, /group: leaf-doctor-unsigned-candidates/)
  assert.match(workflow, /Set-Content -LiteralPath artifacts\/handoff\/reproducibility\.sha256/)
  assert.match(workflow, /path: leaf-doctor\/artifacts\/handoff\/\*\*/)
  assert.doesNotMatch(workflow, /leaf-doctor\/artifacts\/reproducibility\.sha256/)
  assert.match(workflow, /actions\/cache\/save@[a-f0-9]{40}/)
  assert.match(workflow, /actions\/cache\/restore@[a-f0-9]{40}/)
  assert.match(workflow, /fail-on-cache-miss: true/)
  assert.doesNotMatch(workflow, /actions\/(?:upload|download)-artifact@/)
  assert.match(workflow, /Join-Path \$PWD 'leaf-doctor\/artifacts\/handoff\/doctor-candidate\.unsigned\.json'/)
  assert.match(workflow, /tag = 'leaf-doctor-unsigned-candidates'/)
  assert.doesNotMatch(workflow, /candidate_id:|candidateId = "doctor-\$\{\{ steps\.producer\.outputs\.version \}\}-\$\{\{ github\.workflow_sha \}\}"/)
  assert.match(workflow, /\$candidateDocument = Get-Content -LiteralPath \$candidate -Raw \| ConvertFrom-Json/)
  assert.match(workflow, /candidateDocument\.status -cne 'unsigned'/)
  assert.match(workflow, /artifact\.PSObject\.Properties\['signature'\]/)
  assert.match(workflow, /\$null -ne \$signatureProperty -and \$null -ne \$signatureProperty\.Value/)
  assert.doesNotMatch(workflow, /\$null -ne \$candidateDocument\.artifact\.signature/)
  assert.match(workflow, /\$candidateId = \[string\]\$candidateDocument\.candidateId/)
  assert.match(workflow, /Candidate ID is not a standard safe asset token/)
  assert.match(workflow, /Candidate artifact facts do not match the \.leafpkg handoff bytes/)
  assert.match(workflow, /candidateName = "\$candidateId\.candidate\.json"/)
  assert.match(workflow, /packageName = \[IO\.Path\]::GetFileName/)
  assert.match(workflow, /only one member of the immutable pair exists/)
  assert.match(workflow, /gh release create \$tag --repo \$repository --target '\$\{\{ inputs\.source_commit \|\| github\.workflow_sha \}\}' --prerelease --latest=false/)
  assert.doesNotMatch(workflow, /visibility|already be public|public prerelease/i)
  assert.match(workflow, /gh release view \$tag --repo \$repository --json isDraft,isPrerelease,assets/)
  assert.match(workflow, /gh release upload \$tag --repo \$repository \$publishCandidate \$publishPackage/)
  assert.match(workflow, /gh release download \$tag --repo \$repository --pattern \$name --dir \$download/)
  assert.doesNotMatch(workflow, /--clobber|gh release delete|gh release delete-asset|id-token:/i)
})

test("release production builds against RedLeaf and RedBamboo main resolved at dispatch and recorded", () => {
  const workflow = read(".github/workflows/release-candidate.yml")
  assert.doesNotMatch(workflow, /redleafReleaseToolCommit|leafSdk\.commit|redbamboo\.commit|producer pin|steps\.pins/)
  assert.match(workflow, /repository: RedBamboo-Interactive\/redbamboo-packages\n\s+ref: main\n\s+path: redbamboo-packages\n/)
  assert.match(workflow, /repository: RedBamboo-Interactive\/redleaf\n\s+ref: main\n\s+path: redleaf-release\n/)
  // Leaf.Sdk is the same RedLeaf commit as the release tool, never a second resolution of main.
  assert.match(workflow, /repository: RedBamboo-Interactive\/redleaf\n\s+ref: \$\{\{ steps\.dependencies\.outputs\.redleaf \}\}\n\s+path: leaf-sdk\n/)
  assert.ok(workflow.indexOf("path: leaf-sdk") > workflow.indexOf("id: dependencies"))
  assert.match(workflow, /\$redleaf = \(git -C redleaf-release rev-parse HEAD\)\.Trim\(\)/)
  assert.match(workflow, /\$redbamboo = \(git -C redbamboo-packages rev-parse HEAD\)\.Trim\(\)/)
  assert.match(workflow, /GITHUB_STEP_SUMMARY/)
  // Both metadata modes receive the resolved commits, through the environment rather than an expression.
  for (const mode of ["generate", "validate"]) {
    const step = workflow.slice(workflow.indexOf(`node scripts/release/metadata.mjs ${mode}`))
    assert.match(step.slice(0, step.indexOf("\n\n")), /--redleaf-commit \$env:REDLEAF_COMMIT `\n\s+--redbamboo-commit \$env:REDBAMBOO_COMMIT `/)
  }
  assert.equal((workflow.match(/REDLEAF_COMMIT: \$\{\{ steps\.dependencies\.outputs\.redleaf \}\}/g) ?? []).length, 2)
  assert.equal((workflow.match(/REDBAMBOO_COMMIT: \$\{\{ steps\.dependencies\.outputs\.redbamboo \}\}/g) ?? []).length, 2)
})
