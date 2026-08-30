import { describe, expect, it } from "vitest";
import {
  UnsupportedModelError,
  defaultCatalog,
  extractCatalog,
  modelsPayload,
  resolveModel,
} from "../src/models";

describe("modelsPayload", () => {
  it("exposes all fallback models", () => {
    const payload = modelsPayload();
    const ids = new Set(payload.data.map((m: any) => m.id));
    expect(ids.has("Qwen3.7-Max")).toBe(true);
    expect(ids.has("Qwen3.7-Plus")).toBe(true);
    for (const m of payload.data) {
      expect(m.owned_by).toBe("qoder");
    }
  });
});

describe("resolveModel", () => {
  it("resolves default and by name", () => {
    expect(resolveModel(null)).toEqual(["Qwen3.7-Max", "qmodel_latest"]);
    expect(resolveModel("Qwen3.7-Max")).toEqual([
      "Qwen3.7-Max",
      "qmodel_latest",
    ]);
  });

  it("rejects unknown models", () => {
    expect(() => resolveModel("unknown-model")).toThrow(
      UnsupportedModelError,
    );
  });
});

describe("extractCatalog", () => {
  it("derives vision models from is_vl and skips auto", () => {
    const raw = {
      chat: [
        { key: "a", display_name: "ModelA", enable: true, is_vl: true },
        { key: "b", display_name: "ModelB", enable: true, is_vl: false },
        { key: "auto", display_name: "Auto", enable: true, is_vl: true },
        { key: "c", display_name: "ModelC", enable: false, is_vl: true },
      ],
    };
    const cat = extractCatalog(raw);
    expect(cat).not.toBeNull();
    expect(cat!.visionModels.has("ModelA")).toBe(true);
    expect(cat!.visionModels.has("ModelB")).toBe(false);
    expect(cat!.modelMap["Auto"]).toBeUndefined();
    expect(cat!.modelMap["ModelC"]).toBeUndefined();
  });

  it("returns null for unexpected shapes", () => {
    expect(extractCatalog(null)).toBeNull();
    expect(extractCatalog({ chat: {} })).toBeNull();
    expect(extractCatalog({ chat: [] })).toBeNull();
  });

  it("fallback catalog vision set matches Python defaults", () => {
    const fallback = defaultCatalog();
    expect(fallback.visionModels.has("MiniMax-M2.7")).toBe(false);
    expect(fallback.visionModels.has("Qwen3.7-Plus")).toBe(true);
    expect(fallback.defaultName).toBe("Qwen3.7-Max");
  });
});
