import { StorageError } from "./errors.js";

export const MAX_KEY_LENGTH = 512;

/** Why an object key is refused, or undefined when it is valid. */
export function keyProblem(key: string): string | undefined {
  if (key.length === 0) return "key must not be empty";
  if (key.length > MAX_KEY_LENGTH) return `key must be at most ${MAX_KEY_LENGTH} characters`;
  if (key.startsWith("/")) return "key must not start with /";
  if (key.includes("..")) return "key must not contain ..";
  if (key.includes("\\")) return "key must not contain backslashes";
  if (/[\u0000-\u001f\u007f]/.test(key)) return "key must not contain control characters";
  if (key.split("/").some((segment) => segment === "" || segment === ".")) {
    return "key must not contain empty or . path segments";
  }
  return undefined;
}

/** Throws a 400 INVALID_KEY error for a bad key and returns the key otherwise. */
export function assertKey(key: string): string {
  const problem = keyProblem(key);
  if (problem) throw new StorageError(400, "INVALID_KEY", problem);
  return key;
}

/** A list prefix may be empty or end with "/", but follows the same character rules as keys. */
export function prefixProblem(prefix: string): string | undefined {
  if (prefix.length > MAX_KEY_LENGTH) return `prefix must be at most ${MAX_KEY_LENGTH} characters`;
  if (prefix.startsWith("/")) return "prefix must not start with /";
  if (prefix.includes("..")) return "prefix must not contain ..";
  if (prefix.includes("\\")) return "prefix must not contain backslashes";
  if (/[\u0000-\u001f\u007f]/.test(prefix)) return "prefix must not contain control characters";
  return undefined;
}
