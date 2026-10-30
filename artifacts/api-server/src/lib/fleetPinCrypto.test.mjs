import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decryptFleetPairPin, encryptFleetPairPin } from "./fleetPinCrypto.ts";

const vehicleId = "00000000-0000-4000-8000-000000002301";

test("encrypts and decrypts four-digit codes while preserving leading zeroes", () => {
  const prior = process.env.FLEET_DRIVER_PAIR_PIN_ENCRYPTION_KEY_V1;
  process.env.FLEET_DRIVER_PAIR_PIN_ENCRYPTION_KEY_V1 = randomBytes(32).toString("base64");
  try {
    const encrypted = encryptFleetPairPin(vehicleId, "0042");
    assert.equal(encrypted.keyVersion, 1);
    assert.equal(decryptFleetPairPin(vehicleId, encrypted.keyVersion, encrypted.ciphertext), "0042");
    assert.notEqual(encrypted.ciphertext, "0042");
  } finally {
    if (prior === undefined) delete process.env.FLEET_DRIVER_PAIR_PIN_ENCRYPTION_KEY_V1;
    else process.env.FLEET_DRIVER_PAIR_PIN_ENCRYPTION_KEY_V1 = prior;
  }
});

test("ciphertext is authenticated to its vehicle and key version", () => {
  const priorV1 = process.env.FLEET_DRIVER_PAIR_PIN_ENCRYPTION_KEY_V1;
  const priorV2 = process.env.FLEET_DRIVER_PAIR_PIN_ENCRYPTION_KEY_V2;
  process.env.FLEET_DRIVER_PAIR_PIN_ENCRYPTION_KEY_V1 = randomBytes(32).toString("base64");
  process.env.FLEET_DRIVER_PAIR_PIN_ENCRYPTION_KEY_V2 = randomBytes(32).toString("base64");
  try {
    const encrypted = encryptFleetPairPin(vehicleId, "5310");
    assert.equal(encrypted.keyVersion, 2);
    assert.throws(() => decryptFleetPairPin("00000000-0000-4000-8000-000000002302", 2, encrypted.ciphertext));
    assert.throws(() => decryptFleetPairPin(vehicleId, 1, encrypted.ciphertext));
  } finally {
    if (priorV1 === undefined) delete process.env.FLEET_DRIVER_PAIR_PIN_ENCRYPTION_KEY_V1;
    else process.env.FLEET_DRIVER_PAIR_PIN_ENCRYPTION_KEY_V1 = priorV1;
    if (priorV2 === undefined) delete process.env.FLEET_DRIVER_PAIR_PIN_ENCRYPTION_KEY_V2;
    else process.env.FLEET_DRIVER_PAIR_PIN_ENCRYPTION_KEY_V2 = priorV2;
  }
});

test("rejects malformed key material and non-four-digit values", () => {
  const prior = process.env.FLEET_DRIVER_PAIR_PIN_ENCRYPTION_KEY_V1;
  delete process.env.FLEET_DRIVER_PAIR_PIN_ENCRYPTION_KEY_V1;
  try {
    assert.throws(() => encryptFleetPairPin(vehicleId, "1234"));
    process.env.FLEET_DRIVER_PAIR_PIN_ENCRYPTION_KEY_V1 = "not-a-key";
    assert.throws(() => encryptFleetPairPin(vehicleId, "1234"));
    process.env.FLEET_DRIVER_PAIR_PIN_ENCRYPTION_KEY_V1 = randomBytes(32).toString("base64");
    assert.throws(() => encryptFleetPairPin(vehicleId, "123"));
  } finally {
    if (prior === undefined) delete process.env.FLEET_DRIVER_PAIR_PIN_ENCRYPTION_KEY_V1;
    else process.env.FLEET_DRIVER_PAIR_PIN_ENCRYPTION_KEY_V1 = prior;
  }
});
