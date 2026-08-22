import { createHash } from "node:crypto"
import { readFileSync, statSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const FULL_SHA = /^[a-f0-9]{40}$/
const INPUT_KEYS = ["build", "classification", "dependencies", "inputType", "leafSdk", "locks", "redbamboo", "redleafReleaseToolCommit", "runtime", "runtimeRequirements", "schemaVersion", "targetPlatform", "toolchain"]
const PAYLOAD = [
  ["dashboard.html", "dashboard.html"],
  ["doctor-prompt.md", "doctor-prompt.md"],
  ["leaf-doctor.js", "leaf-doctor.js"],
  ["package.json", "package.json"],
]
const LOCKS = [
  ["backend-nuget-lock", "nuget", "src/Leaf.Plugins.Doctor/packages.lock.json"],
  ["redbamboo-pnpm-lock", "npm", "redbamboo-packages/pnpm-lock.yaml"],
  ["tests-nuget-lock", "nuget", "tests/Leaf.Plugins.Doctor.Tests/packages.lock.json"],
  ["web-pnpm-lock", "npm", "web/pnpm-lock.yaml"],
]
const SHARED = [
  ["redbamboo-ui", "@redbamboo/ui", "packages/ui"],
  ["redbamboo-utility", "@redbamboo/utility", "packages/utility"],
]

function fail(message) { throw new Error(message) }
function json(path) { return JSON.parse(readFileSync(path, "utf8")) }
function keys(value) { return Object.keys(value).sort() }
function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(keys(value)) !== JSON.stringify([...expected].sort())) fail(`${label} has unexpected or missing fields.`)
}
function canonical(value) {
  const sort = (item) => Array.isArray(item) ? item.map(sort) : item && typeof item === "object"
    ? Object.fromEntries(keys(item).map((key) => [key, sort(item[key])])) : item
  return `${JSON.stringify(sort(value), null, 2)}\n`
}
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true })
  if (result.error || result.status !== 0) fail((result.stderr || result.stdout || result.error?.message || `${command} failed`).trim())
  return result.stdout.trim()
}
function git(root, ...args) { return run("git", ["-C", root, ...args]) }
function cleanGit(root, label) { if (git(root, "status", "--porcelain=v1", "--untracked-files=all")) fail(`${label} checkout must be clean.`) }
function doctorRuntimeRequirement(input) {
  const values = input.runtimeRequirements.filter((item) => item.id === "doctor-runtime")
  if (values.length !== 1) fail("Doctor runtime version field is missing or ambiguous.")
  return values[0]
}
export function validateExactVersionOverride(head, current, expectedVersion) {
  const headVersion = head.manifest.version
  if (head.packageJson.version !== headVersion || head.runtimePackageJson.version !== headVersion
      || doctorRuntimeRequirement(head.input).versionConstraint !== headVersion) fail("Committed Doctor version fields are inconsistent.")
  if (expectedVersion === headVersion) fail("An ephemeral release override must change the committed version.")
  if (current.manifest.version !== expectedVersion || current.packageJson.version !== expectedVersion
      || current.runtimePackageJson.version !== expectedVersion
      || doctorRuntimeRequirement(current.input).versionConstraint !== expectedVersion) fail("Ephemeral Doctor version fields must match the requested version.")
  const restored = structuredClone(current)
  restored.manifest.version = headVersion
  restored.packageJson.version = headVersion
  restored.runtimePackageJson.version = headVersion
  doctorRuntimeRequirement(restored.input).versionConstraint = headVersion
  if (canonical(restored.manifest) !== canonical(head.manifest)
      || canonical(restored.input) !== canonical(head.input)
      || canonical(restored.packageJson) !== canonical(head.packageJson)
      || canonical(restored.runtimePackageJson) !== canonical(head.runtimePackageJson)) fail("Doctor checkout contains changes beyond the exact release version fields.")
}
function cleanDoctorGit(root, input, manifest, packageJson, runtimePackageJson) {
  const status = git(root, "status", "--porcelain=v1", "--untracked-files=all")
  if (!status) return
  const expectedPaths = ["package.json", "plugin.json", "release/producer-input.v1.json", "web/package.json"]
  const entries = status.split(/\r?\n/)
  if (entries.length !== expectedPaths.length
      || entries.some((entry) => !entry.startsWith(" M "))
      || entries.map((entry) => entry.slice(3)).sort().some((path, index) => path !== expectedPaths[index])) fail("Doctor checkout must be clean except for the exact workflow-owned version fields.")
  const atHead = (path) => JSON.parse(git(root, "show", `HEAD:${path}`))
  validateExactVersionOverride({
    manifest: atHead("plugin.json"),
    input: atHead("release/producer-input.v1.json"),
    packageJson: atHead("web/package.json"),
    runtimePackageJson: atHead("package.json"),
  }, { manifest, input, packageJson, runtimePackageJson }, manifest.version)
}
function hashFile(path) { return createHash("sha256").update(readFileSync(path)).digest("hex") }
function facts(path) { return { sizeBytes: statSync(path).size, sha256: hashFile(path) } }
function exactCommit(value, label) { if (!FULL_SHA.test(value)) fail(`${label} must be one full lowercase commit SHA.`) }
function same(actual, expected, label) { if (canonical(actual) !== canonical(expected)) fail(`${label} drifted.`) }
function addOptional(target, key, value) { if (value !== undefined && value !== null) target[key] = value }

export function validateInput(input, manifest, packageJson, runtimeLock, repository) {
  exactKeys(input, INPUT_KEYS, "producer input")
  exactKeys(input.toolchain, ["dotnetSdk", "msbuild", "node", "pnpm"], "toolchain")
  exactKeys(input.leafSdk, ["commit", "repository", "sourcePath"], "Leaf.Sdk")
  exactKeys(input.redbamboo, ["commit", "inputs", "lockPath", "repository"], "RedBamboo")
  exactKeys(input.build, ["backendProject", "frontendDirectory", "testProject"], "build")
  exactKeys(input.runtime, ["lockPath", "payload"], "runtime")
  exactKeys(input.targetPlatform, ["architecture", "operatingSystem"], "targetPlatform")
  if (input.schemaVersion !== 1 || input.inputType !== "leaf-doctor-extension-release-producer-input") fail("Unsupported producer input.")
  if (input.classification !== "protected") fail("Doctor must be a protected extension.")
  exactCommit(input.redleafReleaseToolCommit, "RedLeaf release-tool pin")
  exactCommit(input.leafSdk.commit, "Leaf.Sdk pin")
  exactCommit(input.redbamboo.commit, "RedBamboo pin")
  if (input.leafSdk.repository !== "RedBamboo-Interactive/redleaf" || input.leafSdk.sourcePath !== "src/Leaf.Sdk") fail("Leaf.Sdk source identity is invalid.")
  if (input.redbamboo.repository !== "RedBamboo-Interactive/redbamboo-packages" || input.redbamboo.lockPath !== "pnpm-lock.yaml") fail("RedBamboo source identity is invalid.")
  if (input.targetPlatform.operatingSystem !== "windows" || input.targetPlatform.architecture !== "x64") fail("Doctor release target must be windows/x64.")
  if (input.build.backendProject !== "src/Leaf.Plugins.Doctor/Leaf.Plugins.Doctor.csproj" || input.build.testProject !== "tests/Leaf.Plugins.Doctor.Tests/Leaf.Plugins.Doctor.Tests.csproj" || input.build.frontendDirectory !== "web") fail("Doctor build layout is invalid.")
  if (manifest.id !== "doctor" || manifest.version !== packageJson.version || manifest.kernelApi !== "^0.1.0" || manifest.backend?.assembly !== "Leaf.Plugins.Doctor" || manifest.frontend?.package !== packageJson.name) fail("Doctor manifest/package identity or layout drifted.")
  if (json(resolve(repository, "package.json")).version !== manifest.version) fail("Doctor runtime package version drifted from the extension manifest.")
  if (manifest.build !== undefined || JSON.stringify(manifest.requires) !== JSON.stringify(["entities"])) fail("Doctor source manifest build evidence or kernel requirements drifted.")
  if (packageJson.name !== "@redbamboo/plugin-doctor" || packageJson.packageManager !== `pnpm@${input.toolchain.pnpm}` || packageJson.engines?.node !== input.toolchain.node) fail("Frontend identity or toolchain pins drifted.")
  if (input.toolchain.node !== runtimeLock.node.version) fail("Build Node and bundled runtime Node versions must agree.")
  same(input.redbamboo.inputs.map((item) => [item.id, item.name, item.sourcePath]), SHARED, "RedBamboo input fan-in")
  input.redbamboo.inputs.forEach((item, index) => exactKeys(item, ["id", "name", "sourcePath"], `redbamboo.inputs[${index}]`))
  const sharedDependencies = Object.entries(packageJson.dependencies).filter(([name]) => name.startsWith("@redbamboo/")).map(([name]) => name).sort()
  same(sharedDependencies, SHARED.map(([, name]) => name).sort(), "frontend shared dependencies")
  for (const [, name, sourcePath] of SHARED) if (packageJson.dependencies[name] !== `link:../../redbamboo-packages/${sourcePath}`) fail(`${name} must use its declared local source link.`)
  same(input.locks.map((item) => [item.id, item.ecosystem, item.path]), LOCKS, "dependency locks")
  input.locks.forEach((item, index) => exactKeys(item, ["ecosystem", "id", "path"], `locks[${index}]`))
  same(input.runtime.payload.map((item) => [item.source, item.target]), PAYLOAD, "runtime payload")
  input.runtime.payload.forEach((item, index) => exactKeys(item, ["source", "target"], `runtime.payload[${index}]`))
  if (input.runtime.lockPath !== "release/doctor-runtime-lock.v1.json") fail("Runtime lock path is invalid.")
  validateRuntimeLock(runtimeLock)
  if (!Array.isArray(input.dependencies) || input.dependencies.length !== 0) fail("Doctor has no extension component dependencies; kernel module requirements belong only in plugin.json.")
  validateRuntimeRequirements(input.runtimeRequirements, manifest.version, repository)
  const processTargets = manifest.permissions.filter((item) => item.kind === "process").map((item) => item.target).sort()
  same(processTargets, ["claude", "cloudflared", "codex", "node"], "process permissions")
  const sourceText = readFileSync(resolve(repository, input.build.backendProject), "utf8")
  if (!sourceText.includes("Leaf.Sdk") || /RedBamboo\.AppHost|AppHost/.test(sourceText)) fail("Backend must reference Leaf.Sdk and must not claim AppHost.")
}

function validateRuntimeLock(lock) {
  exactKeys(lock, ["lockType", "node", "schemaVersion"], "runtime lock")
  exactKeys(lock.node, ["archive", "executable", "platform", "version"], "runtime lock node")
  exactKeys(lock.node.archive, ["fileName", "sha256", "url"], "runtime lock archive")
  exactKeys(lock.node.executable, ["path", "sha256"], "runtime lock executable")
  if (lock.schemaVersion !== 1 || lock.lockType !== "leaf-doctor-runtime-lock" || lock.node.version !== "22.23.1" || lock.node.platform !== "win-x64") fail("Unsupported Doctor runtime lock.")
  if (lock.node.archive.fileName !== "node-v22.23.1-win-x64.zip" || lock.node.archive.url !== "https://nodejs.org/dist/v22.23.1/node-v22.23.1-win-x64.zip") fail("Node runtime archive identity drifted.")
  for (const hash of [lock.node.archive.sha256, lock.node.executable.sha256]) if (!/^[a-f0-9]{64}$/.test(hash)) fail("Runtime lock hashes must be exact lowercase SHA-256 values.")
}

function validateRuntimeRequirements(values, version, repository) {
  const ids = values.map((item) => item.id)
  same(ids, [...ids].sort(), "runtime requirement order")
  same(ids, ["claude-code", "cloudflared", "codex", "doctor-runtime", "node"], "runtime requirement identities")
  for (const [index, item] of values.entries()) {
    exactKeys(item, ["id", "interface", "management", "requirement", "sourceMarkers", "versionConstraint"], `runtimeRequirements[${index}]`)
    if (!item.interface || !item.versionConstraint || !Array.isArray(item.sourceMarkers) || item.sourceMarkers.length === 0) fail(`Runtime '${item.id}' is incomplete.`)
    same(item.sourceMarkers, [...item.sourceMarkers].sort(), `runtime '${item.id}' source markers`)
    for (const sourceMarker of item.sourceMarkers) {
      const split = sourceMarker.indexOf("#")
      if (split <= 0 || split === sourceMarker.length - 1) fail(`Runtime '${item.id}' has an invalid source marker.`)
      const source = resolve(repository, sourceMarker.slice(0, split))
      if (!readFileSync(source, "utf8").includes(sourceMarker.slice(split + 1))) fail(`Runtime '${item.id}' marker '${sourceMarker}' is not present in source.`)
    }
  }
  const doctor = values.find((item) => item.id === "doctor-runtime")
  if (doctor.management !== "managedByExtension" || doctor.requirement !== "required" || doctor.versionConstraint !== version || !doctor.interface.includes("GET /health")) fail("Detached Doctor health/lifecycle contract drifted.")
  const node = values.find((item) => item.id === "node")
  if (node.management !== "managedByExtension" || node.requirement !== "required" || node.versionConstraint !== "22.23.1") fail("Bundled Node runtime contract drifted.")
}

export function buildMetadata(input, manifest, source) {
  const compatibility = { kernelApi: manifest.kernelApi }
  addOptional(compatibility, "computeApi", manifest.computeApi)
  addOptional(compatibility, "productVersion", manifest.productVersion)
  return {
    schemaVersion: 1,
    metadataType: "redleaf-extension-release-metadata",
    classification: input.classification,
    compatibility,
    targetPlatform: input.targetPlatform,
    buildId: `source-${source.doctorCommit}`,
    builtAt: source.builtAt,
    repository: { id: manifest.id, repositoryUrl: source.doctorUrl, commit: source.doctorCommit },
    toolchain: { ...input.toolchain, releaseTool: input.redleafReleaseToolCommit },
    build: { backendProject: input.build.backendProject, frontendDirectory: input.build.frontendDirectory },
    buildInputs: [
      { id: "leaf-sdk", repositoryUrl: source.leafSdkUrl, commit: input.leafSdk.commit, sourcePath: input.leafSdk.sourcePath },
      ...input.redbamboo.inputs.map((item) => ({ id: item.id, repositoryUrl: source.redbambooUrl, commit: input.redbamboo.commit, sourcePath: item.sourcePath })),
    ].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    dependencyLocks: input.locks.map(({ id, ecosystem, path }) => ({ id, ecosystem, path })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    sboms: [],
    dependencies: input.dependencies,
    runtimeRequirements: input.runtimeRequirements,
  }
}

export function validateDescriptor(descriptor, metadata, artifactPath, lockFiles, manifest) {
  const artifact = facts(artifactPath)
  if (descriptor.componentId !== "doctor" || descriptor.version !== manifest.version || descriptor.classification !== "protected" || descriptor.componentKind !== "extension") fail("Descriptor identity or classification is invalid.")
  same(descriptor.compatibility, metadata.compatibility, "descriptor compatibility")
  same(descriptor.evidence.buildInputs, metadata.buildInputs, "descriptor build inputs")
  same(descriptor.evidence.runtimeRequirements, metadata.runtimeRequirements, "descriptor runtime requirements")
  if (descriptor.evidence.repository.commit !== metadata.repository.commit || descriptor.evidence.build.backendProject !== metadata.build.backendProject || descriptor.evidence.build.frontendDirectory !== metadata.build.frontendDirectory) fail("Descriptor source or build layout is invalid.")
  if (descriptor.artifact.sha256 !== artifact.sha256 || descriptor.artifact.sizeBytes !== artifact.sizeBytes) fail("Descriptor artifact facts do not match actual bytes.")
  const expectedLocks = metadata.dependencyLocks.map((item) => ({ ...item, ...facts(lockFiles[item.id]) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  same(descriptor.evidence.dependencyLocks, expectedLocks, "descriptor lock facts")
  const payloadPaths = ["dashboard.html", "doctor-prompt.md", "leaf-doctor.js", "node.exe", "package.json"].map((name) => `payload/doctor/${name}`)
  same(descriptor.provisioning, { present: false, payloadPaths, runtimeRequirements: metadata.runtimeRequirements }, "detached runtime provisioning evidence")
  const permissions = manifest.permissions.map((item) => `${item.kind}:${item.target}`).sort()
  same(descriptor.permissions, permissions, "manifest permissions")
  if (descriptor.dependencies.length !== 0 || descriptor.sboms.length !== 0) fail("Doctor must not acquire synthetic extension dependencies or an SBOM requirement.")
}

function args(values) {
  const parsed = new Map()
  for (let i = 0; i < values.length; i += 2) {
    if (!values[i]?.startsWith("--") || values[i + 1] === undefined || parsed.has(values[i].slice(2))) fail("Arguments must use unique --name value pairs.")
    parsed.set(values[i].slice(2), values[i + 1])
  }
  return (name) => parsed.get(name) ?? fail(`--${name} is required.`)
}

function collect(get) {
  const repository = resolve(get("repository"))
  const redbamboo = resolve(get("redbamboo"))
  const leafSdk = resolve(get("leaf-sdk"))
  const redleaf = resolve(get("redleaf"))
  const input = json(get("input"))
  const manifest = json(resolve(repository, "plugin.json"))
  const packageJson = json(resolve(repository, "web/package.json"))
  const runtimePackageJson = json(resolve(repository, "package.json"))
  const runtimeLock = json(resolve(repository, input.runtime.lockPath))
  validateInput(input, manifest, packageJson, runtimeLock, repository, { resolved: true })
  cleanDoctorGit(repository, input, manifest, packageJson, runtimePackageJson)
  cleanGit(redbamboo, "RedBamboo")
  cleanGit(leafSdk, "Leaf.Sdk")
  cleanGit(redleaf, "RedLeaf release tool")
  const doctorCommit = git(repository, "rev-parse", "HEAD")
  const expectedDoctorCommit = get("source-commit")
  exactCommit(expectedDoctorCommit, "Doctor source commit")
  if (doctorCommit !== expectedDoctorCommit) fail("Doctor checkout does not match github.workflow_sha.")
  if (git(redbamboo, "rev-parse", "HEAD") !== input.redbamboo.commit || git(leafSdk, "rev-parse", "HEAD") !== input.leafSdk.commit || git(redleaf, "rev-parse", "HEAD") !== input.redleafReleaseToolCommit) fail("A source/tool checkout does not match its immutable pin.")
  git(leafSdk, "cat-file", "-e", `HEAD:${input.leafSdk.sourcePath}`)
  for (const item of input.redbamboo.inputs) git(redbamboo, "cat-file", "-e", `HEAD:${item.sourcePath}`)
  const sourceEpoch = get("source-date-epoch")
  if (!/^\d+$/.test(sourceEpoch) || sourceEpoch !== git(repository, "show", "-s", "--format=%ct", "HEAD")) fail("SOURCE_DATE_EPOCH must equal the exact Doctor commit timestamp.")
  const pnpm = process.platform === "win32"
    ? run(process.env.ComSpec, ["/d", "/s", "/c", "corepack.cmd", "pnpm", "--version"])
    : run("corepack", ["pnpm", "--version"])
  const actual = { node: process.version.slice(1), pnpm, dotnetSdk: run("dotnet", ["--version"]), msbuild: run("dotnet", ["msbuild", "-version", "-nologo"]).split(/\r?\n/).at(-1) }
  for (const [name, value] of Object.entries(input.toolchain)) if (actual[name] !== value) fail(`Expected ${name} ${value}, got ${actual[name]}.`)
  const lockFiles = Object.fromEntries(input.locks.map((item) => [item.id, resolve(item.id === "redbamboo-pnpm-lock" ? redbamboo : repository, item.id === "redbamboo-pnpm-lock" ? input.redbamboo.lockPath : item.path)]))
  for (const [id, path] of Object.entries(lockFiles)) if (!statSync(path).isFile()) fail(`Lock '${id}' is missing.`)
  const metadata = buildMetadata(input, manifest, {
    doctorCommit,
    doctorUrl: git(repository, "config", "--get", "remote.origin.url"),
    leafSdkUrl: git(leafSdk, "config", "--get", "remote.origin.url"),
    redbambooUrl: git(redbamboo, "config", "--get", "remote.origin.url"),
    builtAt: new Date(Number(sourceEpoch) * 1000).toISOString(),
  })
  return { input, manifest, metadata, lockFiles }
}

function main() {
  const mode = process.argv[2]
  const get = args(process.argv.slice(3))
  const state = collect(get)
  if (mode === "generate") writeFileSync(get("output"), canonical(state.metadata), { encoding: "utf8", flag: "wx" })
  else if (mode === "validate") {
    const metadata = json(get("metadata"))
    same(metadata, state.metadata, "generated metadata")
    validateDescriptor(json(get("descriptor")), metadata, get("artifact"), state.lockFiles, state.manifest)
  } else fail("Mode must be generate or validate.")
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { main() } catch (error) { process.stderr.write(`release metadata: ${error.message}\n`); process.exitCode = 1 }
}

export { canonical, facts, hashFile, validateRuntimeLock }
