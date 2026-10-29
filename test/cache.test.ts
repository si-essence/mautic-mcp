import { describe, expect, it } from "vitest";
import { TtlCache } from "../src/cache.js";
import { ConnectorError } from "../src/errors.js";

describe("TtlCache", () => {
  it("returns a value until the ttl passes", () => {
    let now = 1_000;
    const cache = new TtlCache(() => now);
    cache.set("widget", { id: "1" }, 10);
    expect(cache.get("widget")).toEqual({ id: "1" });
    now = 10_999;
    expect(cache.get("widget")).toEqual({ id: "1" });
    now = 11_000;
    expect(cache.get("widget")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("rejects a non-positive ttl", () => {
    const cache = new TtlCache(() => 0);
    expect(() => {
      cache.set("widget", 1, 0);
    }).toThrow(ConnectorError);
  });

  it("deletes a key", () => {
    const cache = new TtlCache(() => 0);
    cache.set("widget", "value", 5);
    cache.delete("widget");
    expect(cache.get("widget")).toBeUndefined();
  });

  it("clears every entry", () => {
    const cache = new TtlCache(() => 0);
    cache.set("a", 1, 5);
    cache.set("b", 2, 5);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });
});
