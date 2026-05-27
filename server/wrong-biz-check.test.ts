/**
 * wrong-biz-check.test.ts — Phase 5 wrong-business detection unit tests
 *
 * Per PR #8 addendum directive: 2 tests required.
 */
import { describe, it, expect } from "vitest";
import { checkWrongBusinessPattern } from "./wrong-biz-check";

describe("checkWrongBusinessPattern", () => {
  it("detects known wrong-business phrases", () => {
    const result = checkWrongBusinessPattern("I can help you with a Vistaprint order!");
    expect(result.matched).toBe(true);
    expect(result.pattern).toBeDefined();
  });

  it("returns false for legitimate messages", () => {
    const result = checkWrongBusinessPattern("Hi, thanks for reaching out about t-shirts!");
    expect(result.matched).toBe(false);
    expect(result.pattern).toBeUndefined();
  });
});
