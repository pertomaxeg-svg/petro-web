import test from "node:test";
import assert from "node:assert/strict";
import { formatFleetField } from "./fleetDisplay.ts";

test("plate and category numeric strings are never inferred to be dates", () => {
  assert.equal(formatFleetField("plateOriginal", "2020"), "2020");
  assert.equal(formatFleetField("category", "2020"), "2020");
  assert.equal(formatFleetField("createdAt", "2020"), "تاريخ غير صالح");
});

test("known fleet states and service groups render in Arabic", () => {
  assert.equal(formatFleetField("status", "active"), "نشط");
  assert.equal(formatFleetField("serviceGroup", "batteries"), "البطاريات");
  assert.equal(formatFleetField("fuelType", "diesel"), "سولار");
});

test("minor units display as EGP without floating-point conversion", () => {
  assert.equal(formatFleetField("priceMinor", "12345"), "١٢٣٫٤٥ جنيه مصري");
  assert.equal(formatFleetField("issuePriceMinor", 10000), "١٠٠٫٠٠ جنيه مصري");
  assert.equal(formatFleetField("priceMinor", "12.3"), "قيمة مالية غير صالحة");
});

test("quantities keep their units and do not become dates", () => {
  assert.equal(formatFleetField("readingKm", "1234.5"), "١٬٢٣٤٫٥ كم");
  assert.equal(formatFleetField("expectedConsumption", 8.25), "٨٫٢٥ لتر لكل ١٠٠ كم");
});
