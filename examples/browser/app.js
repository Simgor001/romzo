import {
  buildInviteLink,
  createRoom,
  joinRoom,
  parseInviteHash,
  RelaySession,
} from "romzo";

// The room declares two channels; the relay enforces each channel's
// maxFrameBytes. Options are opaque to the relay — { app: "example" } is
// enough here.
const OPTIONS = {
  app: "example",
  channels: [
    { name: "chat", maxFrameBytes: 16384 },
    { name: "state", maxFrameBytes: 262144 },
  ],
};
const CHAT = "chat";

const $ = (id) => document.getElementById(id);
const status = (text) => { $("status").textContent = text; };

function appendLine(text) {
  const li = document.createElement("li");
  li.textContent = text;
  $("log").appendChild(li);
  $("log").scrollTop = $("log").scrollHeight;
}

let session = null;

async function connect(materials) {
  const url = materials.signedDescriptor
    ? materials.signedDescriptor.descriptor.origin
    : materials.descriptor.origin;
  const wsUrl = url.replace(/^http/, "ws") + "/ws";
  session = await RelaySession.connect(wsUrl, materials.admission, materials.transport);
  session.on("join", (_p, meta) => appendLine(`[join] ${meta.channel} ${short(meta.key)}`));
  session.on("leave", (_p, meta) => appendLine(`[leave] ${meta.channel} ${meta.peer}`));
  session.on("receive", (value, meta) => {
    if (meta.channel === CHAT) appendLine(`${short(meta.peer)}: ${JSON.stringify(value)}`);
  });
  session.on("close", () => { status("closed"); session = null; });
  await session.subscribe(CHAT);
  status(`connected as ${session.id} — subscribed to ${CHAT}`);
}

const short = (key) => (key ? `${key.slice(0, 8)}…` : "?");

$("create").addEventListener("click", async () => {
  try {
    status("creating room…");
    const origin = $("origin").value.trim();
    const password = $("password").value;
    const room = await createRoom(origin, OPTIONS, { password: password || undefined });
    const link = buildInviteLink(
      room.descriptor.origin,
      room.descriptor.code,
      location.origin + location.pathname,
      { allowLoopbackHttp: true },
    );
    $("code").value = room.descriptor.code;
    $("invite").textContent = `invite: ${link}`;
    history.replaceState(null, "", `#${room.descriptor.code}`);
    await connect(room);
  } catch (error) {
    status(`create failed: ${error.message}`);
  }
});

$("join").addEventListener("click", async () => {
  try {
    status("joining room…");
    const joined = await joinRoom($("origin").value.trim(), $("code").value.trim());
    await connect(joined);
  } catch (error) {
    status(`join failed: ${error.message}`);
  }
});

$("compose").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("message");
  const text = input.value.trim();
  if (!text || !session) return;
  input.value = "";
  await session.send(CHAT, { text });
});

// Loading with an invite in the fragment pre-fills the join flow.
if (location.hash) {
  const address = parseInviteHash(location.hash, { allowLoopbackHttp: true });
  if (address) {
    $("origin").value = address.origin;
    $("code").value = address.code;
    history.replaceState(null, "", location.pathname);
    status(`invite loaded: ${address.code} — press "Join room"`);
  }
}
