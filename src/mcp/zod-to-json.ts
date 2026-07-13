/**
 * Минимальный конвертер Zod-схем → JSON Schema для MCP tool inputSchema.
 *
 * Поддерживает только то, что используется в src/mcp/server.ts:
 * z.object, z.string, z.boolean, z.number, .optional(), .default(), .min(), .max(),
 * .describe(). Не общий конвертер — намеренно простой, без зависимости от
 * zod-to-json-schema (та есть как транзитивная, но полагаться на неё ненадёжно).
 *
 * MCP-клиентам достаточно type/properties/description/required — глубокий
 * конвертер избыточен для 4 инструментов.
 */
import type { ZodTypeAny } from "zod";

interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
  default?: unknown;
  [k: string]: unknown;
}

export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
  return convert(schema);
}

function convert(schema: ZodTypeAny): JsonSchema {
  // Zod оборачивает схемы в метаданные (.optional/.default/.describe/.min/.max).
  // _def.typeName указывает на реальный тип; unwrap-обёртки через innerType().
  const typeName = schema._def?.typeName;
  const desc = schema._def?.description as string | undefined;

  switch (typeName) {
    case "ZodObject": {
      const shape = schema._def.shape() as Record<string, ZodTypeAny>;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, val] of Object.entries(shape)) {
        properties[key] = convert(val);
        if (!isOptional(val)) required.push(key);
      }
      const out: JsonSchema = { type: "object", properties, additionalProperties: false };
      if (required.length > 0) out.required = required;
      if (desc) out.description = desc;
      return out;
    }
    case "ZodString":
      return withDesc({ type: "string" }, desc);
    case "ZodBoolean":
      return withDesc({ type: "boolean" }, desc);
    case "ZodNumber":
      return withDesc({ type: "number" }, desc);
    case "ZodArray":
      return withDesc({ type: "array", items: convert(schema._def.type) }, desc);
    case "ZodEnum":
      return withDesc({ type: "string", enum: schema._def.values }, desc);
    case "ZodOptional":
      return convert(schema._def.innerType);
    case "ZodDefault": {
      const inner = convert(schema._def.innerType);
      return withDesc({ ...inner, default: schema._def.defaultValue() }, desc);
    }
    case "ZodEffects":
    case "ZodPipeline":
      // .refine()/.transform() — конвертим inner.
      return convert(schema._def.schema ?? schema._def.in);
    default:
      // Фолбэк: unknown — клиент воспримет как любой тип.
      return desc ? { description: desc } : {};
  }
}

function isOptional(schema: ZodTypeAny): boolean {
  const tn = schema._def?.typeName;
  if (tn === "ZodOptional" || tn === "ZodDefault") return true;
  return false;
}

function withDesc(schema: JsonSchema, desc: string | undefined): JsonSchema {
  if (desc) schema.description = desc;
  return schema;
}
