export interface Dict {
  [key: string]: any;
}

export const DEFAULT_MODEL_MAP: Record<string, string> = {
  "Qwen3.8-Max-Preview": "qmodel_preview",
  "Qwen3.7-Max": "qmodel_latest",
  "Qwen3.7-Plus": "qmodel",
  "Qwen3.6-Flash": "q36fmodel",
  "DeepSeek-V4-Pro": "dmodel",
  "DeepSeek-V4-Flash": "dfmodel",
  "GLM-5.2": "gm51model",
  "Kimi-K2.7-Code": "kmodel",
  "MiniMax-M2.7": "mmodel",
};

export const DEFAULT_VISION_MODELS = new Set<string>([
  "Qwen3.8-Max-Preview",
  "Qwen3.7-Max",
  "Qwen3.7-Plus",
  "Qwen3.6-Flash",
  "DeepSeek-V4-Pro",
  "DeepSeek-V4-Flash",
  "GLM-5.2",
  "Kimi-K2.7-Code",
]);

export const PREFERRED_DEFAULT_KEY = "qmodel_latest";

export const DEFAULT_SCENE = "chat";

export class ModelCatalog {
  constructor(
    public modelMap: Record<string, string>,
    public visionModels: Set<string> = new Set(),
    public defaultName: string = "",
  ) {}

  keys(): string[] {
    return Object.keys(this.modelMap);
  }

  getKey(displayName: string): string | undefined {
    return this.modelMap[displayName];
  }
}

export function defaultCatalog(): ModelCatalog {
  return new ModelCatalog(
    { ...DEFAULT_MODEL_MAP },
    new Set(DEFAULT_VISION_MODELS),
    nameForKey(DEFAULT_MODEL_MAP, PREFERRED_DEFAULT_KEY),
  );
}

export function extractCatalog(
  raw: unknown,
  scene: string = DEFAULT_SCENE,
): ModelCatalog | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const sceneModels = (raw as Dict)[scene];
  if (!Array.isArray(sceneModels)) return null;
  const modelMap: Record<string, string> = {};
  const vision = new Set<string>();
  for (const m of sceneModels) {
    if (typeof m !== "object" || m === null) continue;
    if (!(m.enable ?? true)) continue;
    const key = m.key;
    const name = m.display_name;
    if (!key || !name || key === "auto") continue;
    modelMap[name] = key;
    if (m.is_vl) vision.add(name);
  }
  if (Object.keys(modelMap).length === 0) return null;
  return new ModelCatalog(
    modelMap,
    vision,
    nameForKey(modelMap, PREFERRED_DEFAULT_KEY),
  );
}

export class UnsupportedModelError extends Error {}

export function resolveModel(
  model: string | null | undefined,
  catalog?: ModelCatalog | null,
): [string, string] {
  const cat = catalog ?? defaultCatalog();
  if (model) {
    const key = cat.getKey(model);
    if (!key) {
      const supported = cat.keys().join(", ");
      throw new UnsupportedModelError(
        `Unsupported model ${JSON.stringify(model)}. Supported: ${supported}`,
      );
    }
    return [model, key];
  }
  const name = cat.defaultName || cat.keys()[0] || "";
  return [name, cat.modelMap[name]!];
}

export function modelsPayload(catalog?: ModelCatalog | null): Dict {
  const cat = catalog ?? defaultCatalog();
  return {
    object: "list",
    data: Object.keys(cat.modelMap).map((name) => ({
      id: name,
      object: "model",
      created: 0,
      owned_by: "qoder",
    })),
  };
}

function nameForKey(modelMap: Record<string, string>, key: string): string {
  for (const [name, k] of Object.entries(modelMap)) {
    if (k === key) return name;
  }
  return Object.keys(modelMap)[0] ?? "";
}
