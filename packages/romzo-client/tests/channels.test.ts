import { describe, expect, it } from "vitest";
import {
  MAX_FRAME_BYTES,
  type ChannelDeclaration,
} from "../src/types.js";

import * as sdkTypes from "../src/types.js";

describe("channel declarations", () => {
  it("exports limits without predefined channel names", () => {
    expect(sdkTypes).not.toHaveProperty("DEFAULT_CHANNELS");
    expect(sdkTypes).not.toHaveProperty("CHANNELS");
    expect(MAX_FRAME_BYTES).toBe(256 * 1024);
  });

  it("accepts any declared channel name as a Channel", () => {
    const declared: ChannelDeclaration = { name: "move", maxFrameBytes: 262144 };
    expect(declared.name).toBe("move");
  });
});
