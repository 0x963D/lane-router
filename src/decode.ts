import { err, isNonEmpty, messageOf, ok, type NonEmpty, type Result } from "./result.ts";

/*
 * The one way this codebase turns `unknown` into a typed value. Decoders keep going after a bad
 * value, so one `decode` call reports every issue in its input.
 */

export type DataPath = readonly (string | number)[];

export interface Issue {
  readonly path: DataPath;
  /** `key` when the problem is the key at the end of `path`, such as an unknown key. */
  readonly on: "key" | "value";
  readonly message: string;
}

/** What a decoder returns after it reported an issue. A class, so the type is nominal and never widens. */
export class Invalid {
  declare private readonly invalid: never;
}

export const INVALID = new Invalid();

export interface DecodeContext {
  readonly path: DataPath;
  fail(message: string): Invalid;
  at(segment: string | number): DecodeContext;
  /** The context of the key `segment` itself, so that an issue points at the key and not its value. */
  key(segment: string): DecodeContext;
}

/** A decoder returns INVALID only after it reported an issue through its context. */
export type Decoder<T> = (input: unknown, context: DecodeContext) => T | Invalid;

export type Infer<D> = D extends Decoder<infer T> ? T : never;

export function isValid<T>(value: T | Invalid): value is T {
  return value !== INVALID;
}

export function isRecord(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/** One-based. */
export interface TextPosition {
  readonly line: number;
  readonly column: number;
}

/**
 * JSON text as an untyped value. V8 quotes the input in some of its messages, so a failure keeps
 * only the position V8 names, or null when it names none.
 */
export function parseJson(text: string): Result<unknown, TextPosition | null> {
  try {
    const value: unknown = JSON.parse(text);
    return ok(value);
  } catch (error) {
    const [, line, column] = / in JSON at position \d+ \(line (\d+) column (\d+)\)$/.exec(messageOf(error)) ?? [];
    return err(line === undefined || column === undefined ? null : { line: Number(line), column: Number(column) });
  }
}

export function decode<T>(decoder: Decoder<T>, input: unknown): Result<T, NonEmpty<Issue>> {
  const issues: Issue[] = [];
  const value = decoder(input, contextAt([], "value", issues));
  if (isValid(value) && issues.length === 0) return ok(value);
  return err(isNonEmpty(issues) ? issues : [{ path: [], on: "value", message: "is not valid" }]);
}

function contextAt(path: DataPath, on: Issue["on"], issues: Issue[]): DecodeContext {
  return {
    path,
    fail: (message) => {
      issues.push({ path, on, message });
      return INVALID;
    },
    at: (segment) => contextAt([...path, segment], "value", issues),
    key: (segment) => contextAt([...path, segment], "key", issues),
  };
}

function expected(input: unknown, what: string): string {
  return input === undefined ? "is required" : `expected ${what}`;
}

export const string: Decoder<string> = (input, context) =>
  typeof input === "string" ? input : context.fail(expected(input, "a string"));

export const nonEmptyString: Decoder<string> = (input, context) => {
  const value = string(input, context);
  if (!isValid(value) || value.trim() !== "") return value;
  return context.fail("cannot be empty");
};

export const boolean: Decoder<boolean> = (input, context) =>
  typeof input === "boolean" ? input : context.fail(expected(input, "true or false"));

export function integer(min: number): Decoder<number> {
  return (input, context) =>
    typeof input === "number" && Number.isInteger(input) && input >= min
      ? input
      : context.fail(expected(input, `a whole number of at least ${String(min)}`));
}

export const unknownValue: Decoder<unknown> = (input) => input;

export function literal<const T extends string>(...values: NonEmpty<T>): Decoder<T> {
  return (input, context) =>
    values.find((value) => value === input) ?? context.fail(expected(input, values.join(" or ")));
}

export function array<T>(item: Decoder<T>): Decoder<readonly T[]> {
  return (input, context) => {
    if (!Array.isArray(input)) return context.fail(expected(input, "a list"));
    const items = input.map((value: unknown, index) => item(value, context.at(index)));
    return items.every(isValid) ? items : INVALID;
  };
}

export function nonEmptyArray<T>(item: Decoder<T>): Decoder<NonEmpty<T>> {
  return (input, context) => {
    const items = array(item)(input, context);
    if (!isValid(items) || isNonEmpty(items)) return items;
    return context.fail("cannot be empty");
  };
}

/** A mapping with free-form keys, as ordered entries. `key` reports its issues on the key. */
export function entries<K, V>(key: Decoder<K>, value: Decoder<V>): Decoder<readonly (readonly [K, V])[]> {
  return (input, context) => {
    if (!isRecord(input)) return context.fail(expected(input, "a mapping"));
    const pairs = Object.entries(input).map(([name, raw]) => {
      const decodedKey = key(name, context.key(name));
      const decodedValue = value(raw, context.at(name));
      return isValid(decodedKey) && isValid(decodedValue) ? ([decodedKey, decodedValue] as const) : INVALID;
    });
    return pairs.every(isValid) ? pairs : INVALID;
  };
}

/** Reads one field of a mapping. `object` records each key it is asked for as a known key. */
export type FieldReader = <T>(key: string, decoder: Decoder<T>) => T | Invalid;

/**
 * A mapping with a fixed set of keys. `build` reads every key it accepts, unconditionally, and
 * assembles the value. With `unknownKeys: "reject"` every key it did not read is an issue on that
 * key, with the closest known key as a suggestion. Wire formats use "ignore".
 */
export function object<T>(
  build: (field: FieldReader) => T | Invalid,
  options: { readonly unknownKeys: "reject" | "ignore" },
): Decoder<T> {
  return (input, context) => {
    if (!isRecord(input)) return context.fail(expected(input, "a mapping"));
    const known: string[] = [];
    const field: FieldReader = (key, decoder) => {
      known.push(key);
      return decoder(input[key], context.at(key));
    };
    const value = build(field);
    if (options.unknownKeys === "ignore") return value;
    const unknown = Object.keys(input).filter((key) => !known.includes(key));
    for (const key of unknown) context.key(key).fail(unknownKey(key, known));
    return unknown.length === 0 ? value : INVALID;
  };
}

export function allValid<T extends Readonly<Record<string, unknown>>>(
  fields: T,
): fields is T & { readonly [K in keyof T]: Exclude<T[K], Invalid> } {
  return Object.values(fields).every(isValid);
}

export function optional<T>(decoder: Decoder<T>): Decoder<T | undefined> {
  return (input, context) => (input === undefined ? undefined : decoder(input, context));
}

export function withDefault<T>(decoder: Decoder<T>, fallback: NoInfer<T>): Decoder<T> {
  return (input, context) => (input === undefined ? fallback : decoder(input, context));
}

export function refine<T, U>(decoder: Decoder<T>, next: (value: T, context: DecodeContext) => U | Invalid): Decoder<U> {
  return (input, context) => {
    const value = decoder(input, context);
    return isValid(value) ? next(value, context) : INVALID;
  };
}

export function formatDataPath(path: DataPath): string {
  return path
    .map((segment, index) =>
      typeof segment === "number" ? `[${String(segment)}]` : index === 0 ? segment : `.${segment}`,
    )
    .join("");
}

/** The candidate within two edits of `name`, for "did you mean" messages. */
export function closest(name: string, candidates: readonly string[]): string | undefined {
  let best: { readonly candidate: string; readonly distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = editDistance(name, candidate);
    if (distance <= 2 && (best === undefined || distance < best.distance)) best = { candidate, distance };
  }
  return best?.candidate;
}

function unknownKey(key: string, known: readonly string[]): string {
  const suggestion = closest(key, known);
  return suggestion === undefined
    ? `unknown key, expected one of ${known.join(", ")}`
    : `unknown key, did you mean ${suggestion}?`;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}
