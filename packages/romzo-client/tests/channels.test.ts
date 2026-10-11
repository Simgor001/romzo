import { describe, expect, it } from "vitest";
import {
  CHANNELS,
  DEFAULT_CHANNELS,
  MAX_FRAME_BYTES,
  type ChannelDeclaration,
} from "../src/types.js";

describe("channel declarations", () => {
  it("exposes the compatibility default channel set", () => {
    expect(DEFAULT_CHANNELS).toEqual([
      { name: "discovery", maxFrameBytes: 16 * 1024 },
      { name: "lobby", maxFrameBytes: 16 * 1024 },
      { name: "game", maxFrameBytes: 256 * 1024 },
    ]);
    expect(CHANNELS).toEqual(["discovery", "lobby", "game"]);
    expect(MAX_FRAME_BYTES).toBe(256 * 1024);
    for (const channel of DEFAULT_CHANNELS) {
      expect(channel.maxFrameBytes).toBeGreaterThanOrEqual(256);
      expect(channel.maxFrameBytes).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    }
  });

  it("accepts any declared channel name as a Channel", () => {
    const declared: ChannelDeclaration = { name: "move", maxFrameBytes: 262144 };
    expect(declared.name).toBe("move");
  });
});
