import { CryptoHasher } from "bun";

/**
 * Content digest of a marshaled Op, in the `sha256:<hex>` form used as the key
 * of `Definition.metadata` and of `Input.digest`.
 */
export function digestOf(bytes: Uint8Array): string {
  return "sha256:" + new CryptoHasher("sha256").update(bytes).digest("hex");
}
