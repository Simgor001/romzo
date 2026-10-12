# Browser chat example

A minimal, build-free browser client for the romzo relay: create a room,
share the invite link, join from a second tab, and exchange `chat` messages.

## Run

1. Build the SDK once so the importmap target exists:

   ```sh
   npm run build -w romzo
   ```

2. Start a local relay (see `../node/README.md` for relay setup; use
   `CREATE_AUTH=off` to skip the creation password).

3. Serve this directory over HTTP (any static server) and open it in a
   browser, e.g.:

   ```sh
   npx http-server -p 8080 .
   # or: python -m http.server 8080
   ```

   Private relays check the WebSocket `Origin` against `CLIENT_ORIGINS`; public relays may use `CLIENT_ORIGINS=*`
   (default: the relay's own `PUBLIC_ORIGIN`), so serve the page from an
   origin the relay accepts — `http://127.0.0.1:8080` works when the relay's
   `PUBLIC_ORIGIN`/`CLIENT_ORIGINS` include it.

4. Fill in the relay origin (e.g. `http://127.0.0.1:9224`) and press
   **Create room**. The page shows an invite link, switches to the room code,
   and connects. Open the invite link (or the room code) in another tab to
   join; messages appear in both tabs.

No bundler is involved: `index.html` maps `romzo` to
`../../packages/romzo-client/dist/index.js` through an import map, so the
example always runs against the freshly built workspace SDK.

The room options declare two channels — `chat` (16 KiB) and `state`
(256 KiB) — and are otherwise opaque (`{ app: "example" }`).
