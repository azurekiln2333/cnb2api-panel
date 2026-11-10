import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The key clients use against the unified API. The environment variable wins;
// without it the panel generates a key once and keeps it in the data directory,
// next to master.key. Losing the file only means clients need the new key.
export const GATEWAY_KEY_FILE = "gateway.key";

const MIN_LENGTH = 12;
const PRINTABLE = /^[\x21-\x7e]+$/;

function assertUsable(value, source) {
  if (value.length < MIN_LENGTH)
    throw new Error(`${source} must contain at least 12 characters`);
  if (!PRINTABLE.test(value))
    throw new Error(
      `${source} must contain printable ASCII characters without spaces`,
    );
  return value;
}

export function resolveGatewayKey({ value, adminKey, directory }) {
  if (value !== undefined && String(value).trim() !== "")
    return assertUsable(String(value).trim(), "GATEWAY_KEY");
  const file = join(directory, GATEWAY_KEY_FILE);
  if (existsSync(file)) {
    const saved = readFileSync(file, "utf8").trim();
    if (!saved)
      throw new Error(
        "data/gateway.key is empty; delete it to generate a new gateway key",
      );
    return assertUsable(saved, "data/gateway.key");
  }
  let generated = "";
  do generated = randomBytes(24).toString("hex");
  while (generated === adminKey);
  writeFileSync(file, `${generated}\n`, { mode: 0o600, flag: "wx" });
  return generated;
}
