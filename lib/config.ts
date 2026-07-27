/**
 * Environment configuration, read ONCE (SPEC §11).
 *
 * Two rules this file exists to enforce:
 *  1. `process.env` is read here and nowhere else, so the full set of knobs is greppable and a
 *     typo in a backend name cannot hide inside a service.
 *  2. An unknown backend value **fails fast at startup** with a readable message (CLAUDE.md §3) —
 *     never silently defaults, because a prod deploy quietly falling back to in-memory storage
 *     would lose user data with no error.
 */

export type StorageBackend = "file" | "memory";
export type AssetBackend = "local" | "memory";
export type AuthBackend = "stub";

export interface AppConfig {
  storageBackend: StorageBackend;
  assetBackend: AssetBackend;
  authBackend: AuthBackend;
  dataDir: string;
  defaultUserId: string;
  awsRegion: string;
  defaultLlmModelId: string;
  /** Falls back to `defaultLlmModelId` when unset (SPEC §8: independently configurable). */
  outlineModelId: string;
  generationConcurrency: number;
  maxAssetBytes: number;
  maxSourceTextChars: number;
  /** §7: log final prompts so "no visual vocabulary" is verifiable in debug logs. */
  debugPrompts: boolean;
}

/**
 * `memory` is a first-class, documented option, not a test hack: §6.3 requires that the whole
 * suite pass against a second backend "registered via one factory case", and the honest way to
 * prove that is for the backend to be selectable exactly the way a DynamoDB one would be.
 */
const STORAGE_BACKENDS: readonly StorageBackend[] = ["file", "memory"];
const ASSET_BACKENDS: readonly AssetBackend[] = ["local", "memory"];
const AUTH_BACKENDS: readonly AuthBackend[] = ["stub"];

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function pickEnum<T extends string>(
  name: string, raw: string | undefined, allowed: readonly T[], fallback: T,
): T {
  if (raw === undefined || raw === "") return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  // Fail fast and say exactly what is valid — a misconfigured deploy must not boot.
  throw new ConfigError(`${name}="${raw}" is not supported. Valid values: ${allowed.join(", ")}.`);
}

function pickInt(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name}="${raw}" must be an integer between ${min} and ${max}.`);
  }
  return value;
}

/**
 * Read from a plain string map, not `NodeJS.ProcessEnv` — the only thing this function needs is
 * name→value lookup, and the narrower type lets tests pass a literal without casting (a cast
 * would be the kind of type-hole that hides a real mistake later).
 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

export function loadConfig(env: EnvSource = process.env): AppConfig {
  const defaultLlmModelId = env.DEFAULT_LLM_MODEL_ID ?? "";
  return {
    storageBackend: pickEnum("STORAGE_BACKEND", env.STORAGE_BACKEND, STORAGE_BACKENDS, "file"),
    assetBackend: pickEnum("ASSET_BACKEND", env.ASSET_BACKEND, ASSET_BACKENDS, "local"),
    authBackend: pickEnum("AUTH_BACKEND", env.AUTH_BACKEND, AUTH_BACKENDS, "stub"),
    dataDir: env.DATA_DIR ?? "./data",
    defaultUserId: env.DEFAULT_USER_ID ?? "local-user",
    awsRegion: env.AWS_REGION ?? "us-east-1",
    // NOT validated here: §1.3 requires the app boot and serve `/api/registry/*` with no AWS
    // config at all. A missing model id must fail when generation is attempted, not at startup.
    defaultLlmModelId,
    outlineModelId: env.OUTLINE_MODEL_ID || defaultLlmModelId,
    generationConcurrency: pickInt("GENERATION_CONCURRENCY", env.GENERATION_CONCURRENCY, 2, 1, 8),
    maxAssetBytes: pickInt("MAX_ASSET_MB", env.MAX_ASSET_MB, 5, 1, 50) * 1024 * 1024,
    maxSourceTextChars: pickInt("MAX_SOURCE_TEXT_CHARS", env.MAX_SOURCE_TEXT_CHARS, 20_000, 1_000, 500_000),
    debugPrompts: env.DEBUG_PROMPTS === "1",
  };
}
