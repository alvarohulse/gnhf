import { parseAgentJson } from "./json-extract.js";

export interface AgentOutput {
  success: boolean;
  summary: string;
  key_changes_made: unknown;
  key_learnings: unknown;
  should_fully_stop?: boolean;
}

export interface AgentOutputSchema {
  type: "object";
  additionalProperties: false;
  properties: Record<
    string,
    { type: string; items?: { type: string }; enum?: string[] }
  >;
  required: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeSchemaType(name: string, type: string): string {
  const article = /^[aeiou]/.test(type) ? "an" : "a";
  return `${name} must be ${article} ${type}`;
}

export function validateAgentOutput(
  value: unknown,
  schema: AgentOutputSchema,
): AgentOutput {
  if (!isRecord(value)) {
    throw new Error("expected an object");
  }

  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(schema.properties));
    const extraKey = Object.keys(value).find((key) => !allowed.has(key));
    if (extraKey) {
      throw new Error(`unexpected property ${extraKey}`);
    }
  }

  for (const name of schema.required) {
    if (!(name in value)) {
      throw new Error(`${name} is required`);
    }
  }

  for (const [name, property] of Object.entries(schema.properties)) {
    if (!(name in value)) {
      continue;
    }
    const propertyValue = value[name];

    if (property.type === "array") {
      if (
        !Array.isArray(propertyValue) ||
        property.items?.type !== "string" ||
        !propertyValue.every((item) => typeof item === "string")
      ) {
        throw new Error(`${name} must be an array of strings`);
      }
      continue;
    }

    if (typeof propertyValue !== property.type) {
      throw new Error(describeSchemaType(name, property.type));
    }

    if (property.enum && !property.enum.includes(propertyValue as string)) {
      throw new Error(
        `${name} must be one of ${property.enum.map((item) => JSON.stringify(item)).join(", ")}`,
      );
    }
  }

  return value as unknown as AgentOutput;
}

export function parseAgentOutput(
  text: string,
  schema: AgentOutputSchema,
  agentLabel: string,
): AgentOutput {
  const parsed = parseAgentJson(text, (value) => {
    try {
      validateAgentOutput(value, schema);
      return true;
    } catch {
      return false;
    }
  });
  if (parsed !== null) {
    return validateAgentOutput(parsed, schema);
  }

  const fallbackParsed = parseAgentJson(text);
  if (fallbackParsed !== null) {
    return validateAgentOutput(fallbackParsed, schema);
  }

  throw new SyntaxError(
    `${agentLabel} output did not contain a parseable JSON object`,
  );
}

export interface AgentOutputCommitField {
  name: string;
  allowed?: string[];
}

// Codex's --output-schema enforces OpenAI strict mode, which requires every
// key in `properties` to also appear in `required` when additionalProperties
// is false. So include should_fully_stop only when the run actually uses it.
export function buildAgentOutputSchema(opts: {
  includeStopField: boolean;
  commitFields?: AgentOutputCommitField[];
}): AgentOutputSchema {
  const properties: AgentOutputSchema["properties"] = {
    success: { type: "boolean" },
    summary: { type: "string" },
    key_changes_made: { type: "array", items: { type: "string" } },
    key_learnings: { type: "array", items: { type: "string" } },
  };
  const required = ["success", "summary", "key_changes_made", "key_learnings"];
  for (const field of opts.commitFields ?? []) {
    properties[field.name] = {
      type: "string",
      ...(field.allowed === undefined ? {} : { enum: field.allowed }),
    };
    required.push(field.name);
  }
  if (opts.includeStopField) {
    properties.should_fully_stop = { type: "boolean" };
    required.push("should_fully_stop");
  }
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required,
  };
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens?: number;
  reportedCostUsd?: number;
  tokensAvailable?: boolean;
  // Marks provisional counts for display. tokensAvailable independently
  // declares completeness; limits require available, non-estimated receipts.
  estimated?: boolean;
}

export function isValidTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function hasCompleteTokenUsage(
  usage: TokenUsage,
): usage is TokenUsage & { tokensAvailable: true } {
  return usage.tokensAvailable === true;
}

export function getTokenUsageTotal(usage: TokenUsage): number {
  return isValidTokenCount(usage.totalTokens)
    ? usage.totalTokens
    : usage.inputTokens +
        usage.outputTokens +
        usage.cacheReadTokens +
        usage.cacheCreationTokens;
}

export interface AgentResult {
  output: AgentOutput;
  usage: TokenUsage;
}

export class PermanentAgentError extends Error {
  detail: string;

  constructor(message: string, detail: string) {
    super(message, { cause: detail });
    this.name = "PermanentAgentError";
    this.detail = detail;
  }
}

export class IncompleteAgentShutdownError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IncompleteAgentShutdownError";
  }
}

export class UnverifiedAgentCleanupError extends IncompleteAgentShutdownError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UnverifiedAgentCleanupError";
  }
}

export type OnUsage = (usage: TokenUsage) => void;

export type OnMessage = (text: string) => void;

export interface AgentRunOptions {
  onUsage?: OnUsage;
  onMessage?: OnMessage;
  signal?: AbortSignal;
  logPath?: string;
}

export interface Agent {
  name: string;
  close?(): Promise<void> | void;
  getUnverifiedCleanupError?(): UnverifiedAgentCleanupError | null;
  run(
    prompt: string,
    cwd: string,
    options?: AgentRunOptions,
  ): Promise<AgentResult>;
}
