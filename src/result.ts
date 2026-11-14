export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export type NonEmpty<T> = readonly [T, ...T[]];

export function isNonEmpty<T>(items: readonly T[]): items is NonEmpty<T> {
  return items.length > 0;
}

export function mapNonEmpty<T, U>([first, ...rest]: NonEmpty<T>, transform: (item: T) => U): NonEmpty<U> {
  return [transform(first), ...rest.map(transform)];
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
