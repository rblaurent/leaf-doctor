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
  -LeafSdkProject T:\Projects\redleaf\src\Leaf.Sdk\Leaf.Sdk.csproj
```

The package is written to `dist\doctor-<version>.leafpkg` with a matching SHA-256 file.
The release build includes the local Node executable in the payload so a clean suite
installation does not depend on `node` being present on `PATH`.

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
