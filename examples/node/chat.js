// Single-process two-peer romzo chat demo: one SDK instance hosts a room,
// another joins it, and both exchange three messages on the declared `chat`
// channel. Exits 0 when every message has been echoed, 1 on failure.
//
// Usage: node chat.js <relay-origin> [password]
//   node chat.js http://127.0.0.1:9224
//   node chat.js http://127.0.0.1:9224 create-password

import WebSocket from "ws";
import {
  buildInviteLink,
  createRoom,
  joinRoom,
  RelaySession,
} from "romzo";

const [, , origin, password] = process.argv;
if (!origin) {
  console.error("usage: node chat.js <relay-origin> [password]");
  process.exit(2);
}

// The relay matches the WebSocket Origin header against CLIENT_ORIGINS.
const CLIENT_ORIGIN = "https://chat.example.local";
const socketOptions = {
  webSocketFactory: (url) =>
    new WebSocket(url, { headers: { Origin: CLIENT_ORIGIN } }),
};

const OPTIONS = {
  app: "example",
  channels: [
    { name: "chat", maxFrameBytes: 16384 },
    { name: "state", maxFrameBytes: 262144 },
  ],
};
const CHAT = "chat";
const MESSAGES_PER_PEER = 3;

const short = (key) => (key ? key.slice(0, 8) : "?");

async function main() {
  console.log(`relay: ${origin}`);
  const room = await createRoom(origin, OPTIONS, {
    password: password || undefined,
  });
  console.log(`room:  ${room.descriptor.code} (channels: chat, state)`);
  try {
    const link = buildInviteLink(
      room.descriptor.origin,
      room.descriptor.code,
      "http://localhost:8080/",
      { allowLoopbackHttp: true },
    );
    console.log(`invite: ${link}`);
  } catch {
    console.log(`invite: ${room.descriptor.code} @ ${room.descriptor.origin}`);
  }

  const wsUrl = room.descriptor.origin.replace(/^http/, "ws") + "/ws";
  const host = await RelaySession.connect(
    wsUrl,
    room.admission,
    room.transport,
    socketOptions,
  );

  const guestMaterials = await joinRoom(origin, room.descriptor.code);
  const guest = await RelaySession.connect(
    wsUrl,
    guestMaterials.admission,
    guestMaterials.transport,
    socketOptions,
  );

  let received = 0;
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for messages")),
      15000,
    );
    const finish = () => {
      if (++received === MESSAGES_PER_PEER * 2) {
        clearTimeout(timer);
        resolve();
      }
    };
    for (const [name, session] of [["host", host], ["guest", guest]]) {
      session.on("receive", (value, meta) => {
        if (meta.channel !== CHAT) return;
        console.log(`[${name}] <- ${short(meta.key)}: ${JSON.stringify(value)}`);
        finish();
      });
    }
  });

  await host.subscribe(CHAT);
  await guest.subscribe(CHAT);

  for (let i = 1; i <= MESSAGES_PER_PEER; i++) {
    await host.send(CHAT, { from: "host", seq: i });
    await guest.send(CHAT, { from: "guest", seq: i });
  }

  await done;
  console.log(`ok: ${MESSAGES_PER_PEER * 2} messages exchanged`);
  guest.close();
  host.close();
  // Let the sockets finish closing before the process exits (Windows libuv
  // asserts when process.exit() tears handles down mid-close).
  await new Promise((resolve) => setTimeout(resolve, 200));
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`failed: ${error.message}`);
    process.exit(1);
  },
);
