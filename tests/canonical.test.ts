import { describe, expect, test } from "bun:test";
import { canonicalize } from "../src/canonical";

describe("canonicalization (family rules)", () => {
  test("sorts keys recursively, no whitespace", () => {
    expect(canonicalize({ z: 1, a: { d: 4, c: 3 }, m: [3, 2] })).toBe(
      `{"a":{"c":3,"d":4},"m":[3,2],"z":1}`,
    );
  });

  test("JSON edge semantics + rejection", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(`{"a":1}`);
    expect(canonicalize([1, undefined])).toBe(`[1,null]`);
    expect(canonicalize({ a: NaN })).toBe(`{"a":null}`);
    expect(() => canonicalize({ v: 1n })).toThrow("PROOF_NON_JSON_VALUE");
  });
});
