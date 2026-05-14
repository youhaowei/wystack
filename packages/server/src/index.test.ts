import { describe, expect, test } from "bun:test";
import * as server from "./index";

describe("@wystack/server public API", () => {
  test("exports function builders, registry, and config", () => {
    expect(typeof server.query).toBe("function");
    expect(typeof server.mutation).toBe("function");
    expect(typeof server.createRegistry).toBe("function");
    expect(typeof server.defineConfig).toBe("function");
  });
});
