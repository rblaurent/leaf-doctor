# Leaf Doctor

Leaf Doctor is the RedLeaf suite's independent emergency recovery companion. It is
distributed as a `.leafpkg`: the extension owns installation and settings, while the
Doctor runtime is launched outside RedLeaf's managed-process job so it survives a
kernel crash or restart.

## Ownership

- Extension settings are the only authored configuration.
- `doctor-config` stores ordinary values as entity data and tokens as encrypted secret fields.
- The extension materializes runtime files under `%LOCALAPPDATA%\RedLeaf\Doctor\versions\<version>`.
- The detached process receives secrets through its startup stream or authenticated loopback control API.
- The installed plugin directory is never used as the running location.

## Build

```powershell
pnpm --dir web install
powershell -File .\build-leafpkg.ps1 `
  -LeafSdkProject ..\redleaf\src\Leaf.Sdk\Leaf.Sdk.csproj
```

The package is written to `dist\doctor-<version>.leafpkg` with a matching SHA-256 file.
This developer packer includes the local Node executable. The publication path below
instead verifies and embeds the locked official runtime bytes.

## Release candidate producer

`.github/workflows/release-candidate.yml` is the unsigned acquisition producer; the script
above remains a developer convenience. The workflow checks out Doctor at
`github.workflow_sha`, uses locked NuGet and pnpm graphs, verifies the exact Node 22.23.1
Windows x64 archive and executable from `release/doctor-runtime-lock.v1.json`, and
runs RedLeaf's canonical manifest stage, backend filter, package producer, and
extension ingestor. Two isolated passes must produce identical `.leafpkg`, component
descriptor, unsigned candidate, and signature-input bytes.

Its required `central_release_tag` is a safe tag segment, not an arbitrary URL. The
candidate ingestor derives the only accepted artifact location as
`https://github.com/RedBamboo-Interactive/redleaf/releases/download/<tag>/doctor-<version>.leafpkg`.
After reproducibility checks, a separate serialized bridge on `rblaurent/leaf-doctor`
adds only `<candidateId>.candidate.json` and `<candidateId>.leafpkg` to the fixed
`leaf-doctor-unsigned-candidates` release. Existing pairs are re-downloaded and
hashed for identical reuse; partial or byte-different pairs fail without overwrite or
deletion. The bridge does not sign, request an identity token, or access keys.

Doctor is classified `protected`. Its backend is an ordinary Leaf.Sdk consumer, but
its recovery service is not a RedLeaf managed-process job: the package keeps the four
private runtime sources plus `node.exe` under `payload/doctor`, the extension copies
them into its immutable version directory, launches the detached process, and checks
the loopback `GET /health` version/revision contract. Therefore the generic
`provision.json` contract is deliberately absent; payload and `managedByExtension`
runtime evidence describe the supported model without asking RedLeaf provisioning to
install or own the process.

The producer records only the shared source actually compiled: Leaf.Sdk and the
RedBamboo UI/utility packages. AppHost is neither referenced nor recorded. It emits
no SBOM, signature, registry entry, publication, or Stable/Nightly selection. The
RedLeaf ReleaseTool and Leaf.Sdk source are both pinned to the audited immutable
RedLeaf commit `4bf0894014b392e60cf0b5c6ca85920428ba7516` in
`release/producer-input.v1.json`.

## Development runtime

The legacy `config.json` launch path remains available for direct development. On the
first extension startup, an existing local `config.json` is imported into the entity
configuration and encrypted secret store. Packaged installations never ship that file.

```powershell
npm test
node .\leaf-doctor.js
```

The standalone dashboard accepts an access token through `/session`, exchanges it for
an HttpOnly same-site cookie, and keeps credentials out of subsequent URLs.
