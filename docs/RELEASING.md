# Releasing

Release steps for maintainers. Everything publishes from a clean, verified tree.

## SDK (`romzo`)

1. Ensure `main` is green: `npm run verify`.
2. Bump `packages/romzo-client/package.json` version (semver; the 1.0.0 line starts
   the stable API commitment) and refresh `package-lock.json` (`npm install`).
3. Preflight the package contents: `npm pack -w romzo --dry-run`
   (expect only `dist/`, `README.md`, `LICENSE`).
4. Authenticate with the project npm account: `npm login`.
5. Publish: `npm publish -w romzo --access public`
   (the `--access public` flag is required only for the first publish of a
   scoped package).
6. Tag the repo: `git tag client-v<version>` and push the tag with the commits
   (pushing `main` itself is a separate, explicit decision).

After 1.0.0, follow semver: wire-protocol-visible behavior changes in the relay
bump the server minor/major (`version` in `relay/protocol.go`); SDK-only fixes patch.

## Relay server binary

`npm run build:relay` produces Linux amd64/arm64 and Windows amd64 binaries,
checksums and dependency notices under `dist/relay/`. Attach them to a
GitHub release whose tag matches the `version` constant.

## IANA port

The service port convention (9224) is not yet registered. Submit the
service-name request at <https://www.iana.org/form/ports-services> using the
pre-filled field sheet in [iana-port-9224.md](iana-port-9224.md). Registration
is free; the public FRAMES.md and openapi.yaml satisfy the documentation
requirement. Until it is assigned, treat 9224 as a declared convention.
