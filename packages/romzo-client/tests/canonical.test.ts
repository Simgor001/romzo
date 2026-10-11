import { describe, expect, it } from "vitest";
import { canonical, hash, mac, unhex } from "../src/canonical.js";

describe("canonical JSON", () => {
  it("sorts keys by UTF-16 code unit (not code point)", () => {
    // U+10000 encodes as surrogate pair D800 DC00, which sorts before U+FFFF.
    expect(canonical({ "￿": 1, "𐀀": 2 })).toBe(
      '{"𐀀":2,"￿":1}',
    );
    // BMP astral-adjacent case: é (E9) before z (7A is < E9, so z first).
    expect(canonical({ é: 1, z: 2 })).toBe('{"z":2,"é":1}');
  });

  it("does not escape HTML characters", () => {
    expect(canonical({ a: "<>&" })).toBe('{"a":"<>&"}');
  });

  it("emits U+2028 and U+2029 literally", () => {
    expect(canonical({ a: "x\u2028y\u2029z" })).toBe('{"a":"x\u2028y\u2029z"}');
  });

  it("accepts only safe integers", () => {
    expect(canonical(9007199254740991)).toBe("9007199254740991");
    expect(canonical(-9007199254740991)).toBe("-9007199254740991");
    expect(() => canonical(2 ** 53)).toThrow();
    expect(() => canonical(-(2 ** 53))).toThrow();
    expect(() => canonical(1.5)).toThrow();
    expect(() => canonical(Number.MAX_SAFE_INTEGER + 2)).toThrow();
  });

  it("encodes nested structures deterministically", () => {
    const value = { z: [true, null, 123], a: { b: [1, { c: "x" }] } };
    expect(canonical(value)).toBe('{"a":{"b":[1,{"c":"x"}]},"z":[true,null,123]}');
    // Key insertion order must not matter.
    expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
  });

  it("rejects unsupported values", () => {
    expect(() => canonical(undefined)).toThrow();
    expect(() => canonical(() => {})).toThrow();
    expect(() => canonical(new Date(0))).toThrow();
    expect(() => canonical(10n)).toThrow();
  });

  it("hash and mac use the domain separator", async () => {
    const value = { a: 1 };
    expect(await hash("ru/x/v1", value)).not.toBe(await hash("ru/y/v1", value));
    const key = unhex("ab".repeat(32));
    const a = await mac(key, "ru/x/v1", value);
    const b = await mac(key, "ru/y/v1", value);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
});
