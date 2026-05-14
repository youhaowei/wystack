import { describe, expect, test } from "bun:test";
import * as db from "./index";

describe("@wystack/db public API", () => {
  test("exports schema, driver, and tracking factories", () => {
    expect(typeof db.defineSchema).toBe("function");
    expect(typeof db.createDb).toBe("function");
    expect(typeof db.createReadTracker).toBe("function");
  });
});
