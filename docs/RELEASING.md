# Releasing

Release steps for maintainers. Everything publishes from a clean, verified tree.

## SDK (`romzo`)

1. Ensure `main` is green: `npm run verify`.
2. Bump `packages/romzo-client/package.json` version (semver; the 1.0.0 line starts
   the stable API commitment) and refresh `package-lock.json` (`npm install`).
3. Preflight the package contents: `npm pack -w romzo --dry-run`
   (expect only `dist/`, `README.md`, `LICENSE`).
4. Publishing uses npm Trusted Publishing (OIDC) tied to the `ci.yml`
   workflow in this repository — no npm token secret is required.
5. Tag the repo: `git tag client-v<version>` and push the tag.
   The CI `npm` job verifies the tag against `packages/romzo-client/package.json`,
   reruns the full verification suite, and publishes `romzo` to npmjs
   (`npm publish -w romzo --access public`). Pushing `main` itself does not
   publish.

After 1.0.0, follow semver: wire-protocol-visible behavior changes in the relay
bump the server minor/major (`version` in `relay/protocol.go`); SDK-only fixes patch.

## Relay server binary

`npm run build:relay` produces Linux amd64/arm64 and Windows amd64 binaries,
checksums and dependency notices under `dist/relay/`. Every successful CI run
retains the Linux-built bundle as the `relay-binaries` artifact for 14 days.

After reviewing and explicitly authorizing publication, push a server tag such
as `v1.3.0`. The tag must exactly match `version` in `relay/protocol.go`.
The workflow runs the full verification matrix and native amd64/arm64 Docker
version smoke tests before:

- Publishing `ghcr.io/simgor001/romzo:v1.3.0` for Linux amd64 and arm64.
- Creating a GitHub Release with the three binaries, `SHA256SUMS`, and
  `relay-licenses.tar.gz` (project, Go and dependency license notices).

Branches, pull requests and manual verification runs do not publish the relay.
There is no moving `latest` tag; deployment pins a reviewed server version.
The workflow uses `GITHUB_TOKEN`; no registry password is needed. After the
first image publication, set the GHCR package visibility to **Public** in its
package settings so users can pull without authentication. Repository visibility
alone does not guarantee package visibility.

Release tags are immutable. Binary assets are uploaded to a draft before the
image is published; the release becomes public only after image publication
succeeds. Failed runs can resume an existing draft, but refuse to overwrite an
already published release. If image publication succeeds but final release
publication fails, inspect the versioned image and draft before retrying.
This workflow publishes distribution artifacts; it does not restart an operator's
running relay or publish the npm SDK.

## IANA port

The service port convention (9224) is not yet registered. Submit the
service-name request at <https://www.iana.org/form/ports-services> using the
pre-filled field sheet in [iana-port-9224.md](iana-port-9224.md). Registration
is free; the public FRAMES.md and openapi.yaml satisfy the documentation
requirement. Until it is assigned, treat 9224 as a declared convention.
