import { describe, it, expect } from "vitest";
import { parseArchitectJson, extractKeysLenient } from "./architect.ts";

// review #63 (review-2026-07-13): unescape выполнялся в неверном порядке —
// \n/\t/\" декодировались ДО коллапса \\, поэтому `C:\\newdir` (один \ + newdir)
// превращалось в `C:\` + настоящий newline + `ewdir`. Теперь единый replacer.

describe("extractKeysLenient: unescape order", () => {
  it("preserves Windows path with drive letter (no premature \\n decode)", () => {
    // Сырой JSON-текст: stack_rules = `C:\\Users\\dev` (2 backslash перед каждой буквой).
    // Должно стать `C:\Users\dev` (1 backslash), БЕЗ переводов строк.
    const jsonStr = `{ "stack_rules": "build at C:\\\\Users\\\\dev\\\\repo" }`;
    const res = extractKeysLenient(jsonStr);
    expect(res).not.toBeNull();
    expect(res!.stack_rules).toBe("build at C:\\Users\\dev\\repo");
    // Ключевое: \\n НЕ превратилось в настоящий newline.
    expect(res!.stack_rules).not.toContain("\n");
  });

  it("preserves regex backslash sequences", () => {
    // regex `\d+\s*` в JSON-сырье = `\\d+\\s*` → должно дать `\d+\s*`.
    const jsonStr = `{ "stack_rules": "use \\\\d+\\\\s* in lint" }`;
    const res = extractKeysLenient(jsonStr);
    expect(res!.stack_rules).toBe("use \\d+\\s* in lint");
    expect(res!.stack_rules).not.toContain("\n");
  });
});

describe("parseArchitectJson: strict path keeps backslashes", () => {
  it("well-formed JSON with backslashes parses via JSON.parse", () => {
    const wellFormed = JSON.stringify({
      product: "Path C:\\newdir and regex \\d+",
      architecture: "node",
      code_map: "ok",
    });
    const res = parseArchitectJson(wellFormed);
    expect(res).not.toBeNull();
    expect(res!.product).toBe("Path C:\\newdir and regex \\d+");
    expect(res!.product).not.toContain("\n");
  });
});
