import { Value } from "typebox/value";

/** Provider-local validation; deliberately no Fabric repairs or private runtime imports. */
export function validationMessage(schema: Record<string, unknown>, value: Record<string, unknown>): string | undefined {
  try {
    if (Value.Check(schema, value)) return undefined;
    const messages = [...Value.Errors(schema, value)].slice(0, 5).map(error => {
      const at = (error as { path?: unknown }).path;
      return typeof at === "string" && at !== "" && at !== "/" ? `${at}: ${error.message}` : error.message;
    });
    if (schema.type === "object" && schema.additionalProperties === false && schema.patternProperties === undefined && schema.properties) {
      for (const key of Object.keys(value).filter(key => !Object.hasOwn(schema.properties as object, key)).slice(0, 5)) {
        messages.push(`/${key}: must not have additional properties`);
      }
    }
    const message = messages.join("; ") || "Schema validation failed";
    return message.length <= 2000 ? message : `${message.slice(0, 2000)}…`;
  } catch {
    return "Schema validator failed";
  }
}
