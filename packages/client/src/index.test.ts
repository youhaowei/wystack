import { describe, expect, test } from "bun:test";
import * as client from "./index";

describe("@wystack/client public API", () => {
  test("exports hooks and provider factories", () => {
    expect(typeof client.useQuery).toBe("function");
    expect(typeof client.useMutation).toBe("function");
    expect(typeof client.WyStackProvider).toBe("function");
    expect(typeof client.createWyStackClient).toBe("function");
  });
});
