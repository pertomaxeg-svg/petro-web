import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function encryptionKey(version: number): Buffer {
  const encoded = process.env[`FLEET_DRIVER_PAIR_PIN_ENCRYPTION_KEY_V${version}`];
  if (!encoded || !/^[A-Za-z0-9+/]{43}=?$/.test(encoded)) {
    throw new Error("FLEET_PIN_ENCRYPTION_KEY_UNAVAILABLE");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("FLEET_PIN_ENCRYPTION_KEY_INVALID");
  return key;
}

function currentEncryptionVersion(): number {
  for (let version = 32; version >= 1; version -= 1) {
    if (process.env[`FLEET_DRIVER_PAIR_PIN_ENCRYPTION_KEY_V${version}`]) return version;
  }
  throw new Error("FLEET_PIN_ENCRYPTION_KEY_UNAVAILABLE");
}

function associatedData(vehicleId: string, version: number): Buffer {
  return Buffer.from(`pertomax-eg:fleet:driver-pair-pin:v${version}:${vehicleId.toLowerCase()}`, "utf8");
}

export function encryptFleetPairPin(vehicleId: string, pinCode: string): { keyVersion: number; ciphertext: string } {
  if (!/^[0-9]{4}$/.test(pinCode) || !/^[0-9a-f-]{36}$/i.test(vehicleId)) {
    throw new Error("FLEET_PIN_INPUT_INVALID");
  }
  const keyVersion = currentEncryptionVersion();
  const key = encryptionKey(keyVersion);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(associatedData(vehicleId, keyVersion));
  const encrypted = Buffer.concat([cipher.update(pinCode, "utf8"), cipher.final()]);
  return {
    keyVersion,
    ciphertext: Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("hex"),
  };
}

export function decryptFleetPairPin(vehicleId: string, keyVersion: number, ciphertextHex: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(vehicleId)
      || !Number.isInteger(keyVersion) || keyVersion < 1 || keyVersion > 32
      || !/^(?:[0-9a-f]{2}){32,512}$/i.test(ciphertextHex)) {
    throw new Error("FLEET_PIN_CIPHERTEXT_INVALID");
  }
  const key = encryptionKey(keyVersion);
  const packed = Buffer.from(ciphertextHex, "hex");
  const nonce = packed.subarray(0, 12);
  const tag = packed.subarray(12, 28);
  const ciphertext = packed.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(associatedData(vehicleId, keyVersion));
  decipher.setAuthTag(tag);
  const pinCode = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  if (!/^[0-9]{4}$/.test(pinCode)) throw new Error("FLEET_PIN_PLAINTEXT_INVALID");
  return pinCode;
}
