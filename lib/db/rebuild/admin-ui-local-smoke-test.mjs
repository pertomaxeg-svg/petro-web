import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function httpJson(url, method = "GET") {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try {
          resolve({ status: response.statusCode, body: body ? JSON.parse(body) : null });
        } catch {
          resolve({ status: response.statusCode, body });
        }
      });
    });
    request.once("error", reject);
    request.end();
  });
}

async function waitForHttp(url, child, output) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Local web test server exited early:\n${output.join("")}`);
    }
    try {
      const response = await httpJson(url);
      if (response.status === 200) return;
    } catch {
      // The Vite server is still starting.
    }
    await delay(200);
  }
  throw new Error(`Timed out starting local web test server:\n${output.join("")}`);
}

async function waitForFile(filePath, child, browserOutput) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Headless browser exited before DevTools became ready (${child.exitCode ?? child.signalCode}): ${browserOutput.join("").slice(-3000)}`);
    try {
      return await readFile(filePath, "utf8");
    } catch {
      await delay(100);
    }
  }
  throw new Error(`Headless browser DevTools did not start: ${browserOutput.join("").slice(-3000)}`);
}

function cairoLocalDateTime(offsetMinutes = -5) {
  const date = new Date(Date.now() + offsetMinutes * 60_000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}`;
}

function makeAuthCookie(projectRef, actorId) {
  const now = Math.floor(Date.now() / 1000);
  const tokenPayload = Buffer.from(JSON.stringify({
    sub: actorId,
    aud: "authenticated",
    role: "authenticated",
    exp: now + 3600,
  })).toString("base64url");
  const session = {
    access_token: `eyJhbGciOiJub25lIn0.${tokenPayload}.local-test`,
    refresh_token: "local-test",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: now + 3600,
    user: { id: actorId, aud: "authenticated", role: "authenticated" },
  };
  return {
    name: `sb-${projectRef}-auth-token`,
    value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`,
  };
}

function createCdp(socket) {
  let nextId = 0;
  const pending = new Map();
  const storageImageRequests = new Map();
  const storageImageEvents = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Network.requestWillBeSent" && typeof message.params?.request?.url === "string"
      && message.params.request.url.includes("/__local-test-storage/")) {
      storageImageRequests.set(message.params.requestId, message.params.request.url);
    } else if (message.method === "Network.responseReceived" && storageImageRequests.has(message.params?.requestId)) {
      storageImageEvents.push({
        url: storageImageRequests.get(message.params.requestId),
        status: message.params.response?.status,
        mimeType: message.params.response?.mimeType,
      });
    } else if (message.method === "Network.loadingFailed" && storageImageRequests.has(message.params?.requestId)) {
      storageImageEvents.push({
        url: storageImageRequests.get(message.params.requestId),
        errorText: message.params.errorText,
        blockedReason: message.params.blockedReason ?? "",
      });
    }
    if (!message.id) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result ?? {});
  });
  return {
    storageImageEvents() { return storageImageEvents.slice(); },
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`DevTools command timed out: ${method}`));
        }, 15_000);
        pending.set(id, {
          resolve: (value) => { clearTimeout(timeout); resolve(value); },
          reject: (error) => { clearTimeout(timeout); reject(error); },
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    async evaluate(expression) {
      const result = await this.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Browser evaluation failed.");
      }
      return result.result?.value;
    },
  };
}

async function runBrowserSteps(cdp, webPort, { vehicleImagePath, odometerImagePath, setStorageSignFailure }) {
  async function waitForText(text, timeout = 20_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const body = await cdp.evaluate("document.body?.innerText ?? ''");
      if (body?.includes(text)) return body;
      await delay(200);
    }
    const body = await cdp.evaluate("document.body?.innerText ?? ''");
    throw new Error(`UI did not show "${text}". Current page text:\n${String(body).slice(0, 2000)}`);
  }

  async function waitForSelector(selector) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) return;
      await delay(100);
    }
    const diagnostics = await cdp.evaluate(`(async () => ({
      url: location.pathname,
      page: (document.body?.innerText ?? "").slice(-1800),
      pickerStates: [...document.querySelectorAll(".fleet-reference-state")].map((item) => item.innerText),
      organizationInputs: [...document.querySelectorAll('[data-testid="fleet-reference-organizationId-input"]')].map((input) => ({
        expanded: input.getAttribute("aria-expanded"),
        active: input === document.activeElement,
        value: input.value
      })),
      organizationProbe: await fetch("/api/organizations?page=1&pageSize=20&kind=company&sortBy=name&sortDirection=asc", { credentials: "include" })
        .then(async (response) => {
          const data = await response.json().catch(() => ({}));
          const first = Array.isArray(data.items) ? data.items[0] : null;
          return {
            status: response.status,
            keys: Object.keys(data),
            count: Array.isArray(data.items) ? data.items.length : null,
            firstItem: first ? { id: first.id, name: first.name, kind: first.kind } : null,
            message: data.message
          };
        })
        .catch((error) => ({ error: String(error) }))
    }))()`);
    throw new Error(`UI did not render selector ${selector}: ${JSON.stringify(diagnostics)}`);
  }

  async function setValue(selector, value) {
    const expression = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const prototype = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
        : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(el, ${JSON.stringify(value)});
      else el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`;
    assert.equal(await cdp.evaluate(expression), true, `Missing form field ${selector}`);
  }

  async function setFile(selector, filePath) {
    await cdp.send("DOM.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    assert.ok(nodeId, `Missing file input ${selector}`);
    await cdp.send("DOM.setFileInputFiles", { nodeId, files: [filePath] });
    await delay(200);
  }

  async function setChecked(selector, checked = true) {
    const expression = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const expected = ${JSON.stringify(checked)};
      if (el.checked !== expected) el.click();
      return el.checked === expected;
    })()`;
    assert.equal(await cdp.evaluate(expression), true, `Missing checkbox ${selector}`);
  }

  async function click(selector) {
    assert.equal(await cdp.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el || el.disabled) return false;
      el.click();
      return true;
    })()`), true, `Could not click ${selector}`);
  }

  async function clickButtonText(text, within = "document") {
    const expression = `(() => {
      const root = ${within};
      const button = [...root.querySelectorAll("button")].find((item) =>
        item.innerText.includes(${JSON.stringify(text)}) && !item.disabled
      );
      if (!button) return false;
      button.click();
      return true;
    })()`;
    if (await cdp.evaluate(expression) !== true) {
      const body = await cdp.evaluate("document.body?.innerText ?? ''");
      throw new Error(`Could not find enabled button "${text}". Current page text:\n${String(body).slice(0, 3000)}`);
    }
  }

  async function clickTabText(text, scopeSelector) {
    const result = await cdp.evaluate(`(() => {
      const scope = document.querySelector(${JSON.stringify(scopeSelector)});
      if (!scope) return { clicked: false, tabs: [], reason: "scope" };
      const tabs = [...scope.querySelectorAll("button,[role=tab]")];
      const tab = tabs.find((item) => item.innerText.trim().includes(${JSON.stringify(text)}) && !item.disabled);
      if (!tab) return { clicked: false, tabs: tabs.map((item) => item.innerText.trim()), reason: "tab" };
      tab.click();
      return { clicked: true };
    })()`);
    assert.equal(result?.clicked, true, `Could not find tab "${text}" in ${scopeSelector}: ${JSON.stringify(result)}`);
  }

  async function navigate(pathname, expectedText) {
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${webPort}${pathname}` });
    try {
      await waitForText(expectedText);
    } catch (error) {
      const diagnostics = await cdp.evaluate(`fetch("/api/auth/me", { credentials: "include" })
        .then(async (response) => ({ status: response.status, body: (await response.text()).slice(0, 300),
          sessionCookiePresent: document.cookie.includes("sb-") }))
        .catch((failure) => ({ error: String(failure), sessionCookiePresent: document.cookie.includes("sb-") }))`);
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nAuth probe: ${JSON.stringify(diagnostics)}`);
    }
  }

  async function settleResponsiveLayout() {
    await cdp.evaluate(`(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const sidebar = document.querySelector(".ac-sidebar");
      if (sidebar) await Promise.all(sidebar.getAnimations().map(animation => animation.finished.catch(() => {})));
    })()`);
  }

  async function assertResponsiveLayout() {
    for (const [width, height] of [[1280, 900], [1440, 900], [768, 1024], [390, 844], [360, 800]]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width, height, deviceScaleFactor: 1, mobile: width < 600,
      });
      await settleResponsiveLayout();
      const dimensions = await cdp.evaluate(`({
        width: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth
      })`);
      assert.ok(
        dimensions.documentWidth <= width && dimensions.bodyWidth <= width,
        `Page has horizontal overflow at ${width}px: ${JSON.stringify(dimensions)}`,
      );
      if (width <= 760) {
        assert.equal(await cdp.evaluate(`(() => {
          const sidebar = document.querySelector(".ac-sidebar");
          return !sidebar || sidebar.classList.contains("drawer-open") || sidebar.getBoundingClientRect().left >= innerWidth;
        })()`), true, "Closed mobile navigation must not cover the page.");
      }
    }
    await cdp.send("Emulation.clearDeviceMetricsOverride");
  }

  const planName = `خطة واجهة معزولة ${Date.now()}`;
  const planCode = `ui_plan_${Date.now()}`;
  await navigate("/admin/plans", "الخطط والإصدارات");
  await clickButtonText("إنشاء خطة مسودة");
  await waitForText("إنشاء خطة");
  await setValue('input[name="name"]', planName);
  await setValue('input[name="code"]', planCode);
  await setValue('input[name="description"]', "اختبار واجهة محلي لا ينشر خطة");
  await setValue('select[name="audience"]', "company");
  await setValue('input[name="price"]', "800");
  await setValue('input[name="effectiveAt"]', cairoLocalDateTime(60));
  await clickButtonText("حفظ كمسودة");
  await waitForText("الخطة كمسودة دون حقوق معتمدة");
  await waitForText(planName);
  const expandPlan = `(() => {
    const button = [...document.querySelectorAll(".ab-expand")]
      .find((item) => item.innerText.includes(${JSON.stringify(planName)}));
    if (!button) return false;
    button.click();
    return true;
  })()`;
  const expandPlanByCode = `(() => {
    const button = [...document.querySelectorAll(".ab-expand")]
      .find((item) => item.innerText.includes(${JSON.stringify(planCode)}));
    if (!button) return false;
    button.click();
    return true;
  })()`;
  assert.equal(await cdp.evaluate(expandPlan), true, "Created plan did not appear in the plans table.");
  await waitForText("مراجعة النشر");
  await clickButtonText("مراجعة النشر");
  await waitForSelector('[data-testid="plan-publication-blocked"]');
  assert.equal(await cdp.evaluate('document.querySelector(\'[data-testid="plan-publication-submit"]\')?.disabled'),true,"Incomplete plan must explain missing feature before sending publish request");
  await waitForText("أضف ميزة واحدة على الأقل");
  await click('[data-testid="plan-publication-edit"]');
  await waitForText("تحرير مسودة");
  await setValue('[data-testid="input-plan-version-name"]', "نسخة اختبار واجهة");
  await setValue('[data-testid="input-plan-version-price"]', "525.75");
  await setValue('[data-testid="input-plan-version-effective-at"]', cairoLocalDateTime(60));
  await click('[data-testid="button-add-entitlements"]');
  await setValue('[data-testid="input-entitlements-label-0"]', "ميزة واجهة اختبارية");
  await setValue('[data-testid="input-entitlements-text-0"]', "متاحة");
  await setChecked('[data-testid="checkbox-entitlements-approved-0"]', true);
  await click('[data-testid="button-add-settings"]');
  await setValue('[data-testid="input-settings-label-0"]', "حد واجهة اختباري");
  await setValue('[data-testid="select-settings-value-mode-0"]', "number");
  await setValue('[data-testid="input-settings-number-0"]', "25");
  await setChecked('[data-testid="checkbox-settings-approved-0"]', true);
  await click('[data-testid="button-save-plan-version"]');
  await waitForText("تم حفظ تعديلات المسودة");
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${webPort}/admin/plans` });
  await waitForText("الخطط والإصدارات");
  await waitForText(planCode);
  assert.equal(await cdp.evaluate(expandPlanByCode), true, "Edited plan was not returned after browser reload.");
  const planDetail = await waitForText("ميزة واجهة اختبارية");
  assert.ok(planDetail.includes("حد واجهة اختباري"), "Plan settings were not displayed after reload.");
  await clickButtonText("مراجعة النشر");
  await waitForSelector('[data-testid="plan-publication-submit"]');
  assert.equal(await cdp.evaluate('document.querySelector(\'[data-testid="plan-publication-submit"]\')?.disabled'),false);
  await click('[data-testid="plan-publication-submit"]');
  await waitForText("تمت جدولة الباقة حسب تاريخ السريان المحدد.");
  await cdp.send("Page.navigate",{url:`http://127.0.0.1:${webPort}/admin/plans`});
  await waitForText(planCode);
  assert.equal(await cdp.evaluate(expandPlanByCode),true);
  const publishedPlan=await waitForText("ميزة واجهة اختبارية");
  assert.ok(publishedPlan.includes("مجدول"),"Browser publishing must persist actual scheduled state after reload");
  console.log("PASS: incomplete package publication explains missing features and opens editing; reviewed price/features/settings publish and persist scheduled state through actual API.");

  await assertResponsiveLayout();

  const fuelName = `وقود واجهة معزول ${Date.now()}`;
  const fuelCode = `ui_test_${Date.now()}`;
  await navigate("/admin/fuel-prices", "أسعار الوقود");
  await waitForText("gasoline_92");
  await clickButtonText("إضافة نوع وقود");
  await setValue('input[name="nameAr"]', fuelName);
  await setValue('input[name="code"]', fuelCode);
  await setValue('select[name="family"]', "gasoline");
  await setValue('select[name="unitCode"]', "litre");
  await clickButtonText("حفظ تعريف الوقود");
  await waitForText(fuelName);
  const openFuelPrice = `(() => {
    const row = [...document.querySelectorAll("tr")].find((item) => item.innerText.includes(${JSON.stringify(fuelCode)}));
    const button = row && [...row.querySelectorAll("button")].find((item) => item.innerText.includes("تحديد السعر"));
    if (!button) return false;
    button.click();
    return true;
  })()`;
  assert.equal(await cdp.evaluate(openFuelPrice), true, "Fuel row did not offer a direct price action.");
  await setValue('.cat-editor form.cat-form input[name="price"]', "4.2375");
  await setValue('.cat-editor form.cat-form input[name="effectiveAt"]', cairoLocalDateTime(5));
  const fuelDraftInputs = await cdp.evaluate(`(() => {
    const form = document.querySelector(".cat-editor form.cat-form");
    if (!form) return null;
    return {
      valid: form.checkValidity(),
      fields: [...form.querySelectorAll("input")].map((input) => ({
        name: input.name, value: input.value, valid: input.checkValidity()
      }))
    };
  })()`);
  assert.equal(fuelDraftInputs?.valid, true, `Fuel draft form is invalid: ${JSON.stringify(fuelDraftInputs)}`);
  await clickButtonText("حفظ مسودة السعر");
  await waitForText("تم تسجيل الإجراء على الوقود.");
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${webPort}/admin/fuel-prices` });
  const fuelDetail = await waitForText(fuelName);
  assert.ok(fuelDetail.includes("لتر"), "Fuel price unit was not rendered as litres after reload.");
  const openFuelHistory = `(() => {
    const row = [...document.querySelectorAll("tr")].find((item) => item.innerText.includes(${JSON.stringify(fuelCode)}));
    const button = row && [...row.querySelectorAll("button")].find((item) => item.innerText.includes("عرض السجل"));
    if (!button) return false;
    button.click();
    return true;
  })()`;
  assert.equal(await cdp.evaluate(openFuelHistory), true, "Saved fuel price history could not be opened after reload.");
  await waitForText("مسودة غير منشورة · نسخة");
  await assertResponsiveLayout();

  await navigate("/admin/fleet/vehicles/new", "إضافة مركبة");
  await waitForSelector('[data-testid="fleet-command-submit"]');
  await assertResponsiveLayout();
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await settleResponsiveLayout();
  await writeFile(path.join(os.tmpdir(), "pertomax-fleet-wizard-desktop.png"), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })).data, "base64"));
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await clickButtonText("التالي");
  const emptyVehicleStep = await cdp.evaluate("document.body.innerText");
  assert.ok(emptyVehicleStep.includes("أكمل الحقل المحدد") && emptyVehicleStep.includes("مطلوب"), `Vehicle wizard did not show Arabic field errors:\n${emptyVehicleStep.slice(-1500)}`);
  assert.ok(!emptyVehicleStep.includes("Please fill out this field"), "Vehicle wizard exposed native English validation.");
  await setValue('input[name="plateOriginal"]', "TEST-UI-VEHICLE-01");
  await setValue('input[name="category"]', "خصوصي تجريبي");
  await setValue('input[name="vehicleType"]', "سيارة ركوب تجريبية");
  const fuelOption = await cdp.evaluate(`(() => [...(document.querySelector('select[name="fuelType"]')?.options ?? [])]
    .find((option) => option.value && !option.disabled)?.value ?? "")()`);
  assert.ok(fuelOption, "Vehicle wizard has no selectable fuel type.");
  await setValue('select[name="fuelType"]', fuelOption);
  await setValue('input[name="brand"]', "مصنّع تجريبي");
  await setValue('input[name="model"]', "طراز تجريبي");
  await setValue('input[name="tankCapacityLiters"]', "50");
  await clickButtonText("التالي");
  await waitForSelector('[data-testid="fleet-reference-organizationId-input"]');
  await setValue('[data-testid="fleet-reference-organizationId-input"]', "API Fleet");
  await waitForSelector('[data-testid="fleet-reference-organizationId-option-0"]');
  assert.equal(await cdp.evaluate(`(() => {
    const option = document.querySelector('[data-testid="fleet-reference-organizationId-option-0"]');
    if (!option) return false;
    option.click();
    return true;
  })()`), true, "Vehicle wizard could not select a company by name.");
  await setValue('[data-testid="fleet-reference-branchId-input"]', "API");
  await waitForSelector('[data-testid="fleet-reference-branchId-option-0"]');
  await cdp.evaluate(`document.querySelector('[data-testid="fleet-reference-branchId-option-0"]')?.click()`);
  await clickButtonText("التالي");
  await waitForSelector('[data-testid="fleet-create-driver-mode"]');
  const optionalVehicleControls = await cdp.evaluate(`(() => ({
    imageInputs: [...document.querySelectorAll('input[type="file"]')].length,
    odometer: Boolean(document.querySelector('[name="initialReadingKm"]')),
    usagePolicy: Boolean(document.querySelector('[data-testid="fleet-create-policy-enabled"]'))
  }))()`);
  assert.ok(optionalVehicleControls.imageInputs >= 2, "Vehicle and odometer evidence controls are missing from the wizard.");
  assert.equal(optionalVehicleControls.odometer, true, "Initial odometer input is missing from the wizard.");
  assert.equal(optionalVehicleControls.usagePolicy, true, "Initial vehicle usage policy option is missing from the wizard.");
  await setValue('select[name="initialDriverMode"]', "new");
  assert.equal(await cdp.evaluate(`Boolean(document.querySelector('input[name="newDriverCode"]'))`), false, "Driver operational code should be assigned by the server, not requested in onboarding.");
  await setValue('input[name="newDriverName"]', "سائق اختبار معزول");
  await setValue('input[name="initialDriverPin"]', "");
  assert.equal(await cdp.evaluate(`Boolean(document.querySelector('input[name="initialLinkStartsAt"], input[name="initialLinkEndsAt"]'))`), false, "Driver assignment dates should be generated by the system.");
  const pinInput = await cdp.evaluate(`(() => document.querySelector('[data-testid="fleet-create-driver-pin"]')?.type ?? "")()`);
  assert.equal(pinInput, "password", "New driver PIN is not masked by default.");
  await setValue('[data-testid="fleet-create-odometer-reading"]', "42500");
  await setValue('[data-testid="fleet-create-odometer-time"]', cairoLocalDateTime(-5));
  await setFile('[data-testid="fleet-create-vehicle-photo"]', vehicleImagePath);
  await setFile('[data-testid="fleet-create-odometer-evidence"]', odometerImagePath);
  const policyToggle = await cdp.evaluate(`(() => {
    const checkbox = document.querySelector('[data-testid="fleet-create-policy-enabled"]');
    return Boolean(checkbox && !checkbox.disabled);
  })()`);
  assert.equal(policyToggle, true, "The isolated onboarding schema must expose editable vehicle usage policies.");
  await setChecked('[data-testid="fleet-create-policy-enabled"]');
  await setChecked('[data-testid="fleet-create-policy-day-1"]');
  await setValue('[data-testid="fleet-create-policy-effective"]', cairoLocalDateTime(5));
  await setValue('[data-testid="fleet-create-onboardingDailyAmountEgp"]', "3000");
  await setValue('[data-testid="fleet-create-onboardingWeeklyAmountEgp"]', "10000");
  await setChecked('[data-testid="fleet-create-policy-fuel"]');
  await setValue('[data-testid="fleet-create-onboardingRule_fuel_maxOperationQuantity"]', "50");
  await setChecked('[data-testid="fleet-create-policy-wash"]');
  await setValue('[data-testid="fleet-create-onboardingRule_wash_maxOperationQuantity"]', "1");
  const nfcEnabled = await cdp.evaluate(`(() => {
    const select = document.querySelector('select[name="credentialType"]');
    const option = [...(select?.options ?? [])].find((item) => item.value === "nfc");
    return Boolean(option && !option.disabled);
  })()`);
  assert.equal(nfcEnabled, true, "Optional NFC request is not available in the isolated onboarding fixture.");
  await setValue('select[name="credentialType"]', "nfc");
  await setValue('select[name="fulfillmentMethod"]', "pickup");
  await setValue('input[name="pickupLocation"]', "مكتب استقبال الفرع");
  assert.equal(await cdp.evaluate(`(() => [...document.querySelectorAll('input[name="fulfillmentContactName"],input[name="fulfillmentContactPhone"]')].every(input => input.closest('[hidden]')))()`), true, "Pickup requests must not require or display installation contact fields.");
  await clickButtonText("التالي");
  const vehicleReview = await waitForText("مراجعة قبل الحفظ");
  assert.ok(vehicleReview.includes("طلب NFC") && vehicleReview.includes("استلام من الفرع"));
  assert.ok(vehicleReview.includes("سجل سائق جديد") && vehicleReview.includes("صورة مرفقة"));
  await clickButtonText("إنشاء المركبة");
  await waitForSelector(".fleet-feedback.is-error");
  const isolatedUploadFailure = await cdp.evaluate('document.querySelector(".fleet-feedback.is-error")?.innerText ?? ""');
  assert.ok(isolatedUploadFailure.trim().length > 0 && !isolatedUploadFailure.includes("Please fill out this field"));
  await clickButtonText("إنشاء المركبة");
  await waitForSelector('[data-testid="fleet-driver-pin-once"]');
  const initialDriverPairPin = await cdp.evaluate(`document.querySelector('[data-testid="fleet-driver-pin-once"]')?.textContent?.trim() ?? ""`);
  const generatedPinIsFourDigits = /^\d{4}$/.test(initialDriverPairPin);
  assert.equal(generatedPinIsFourDigits, true, "The saved driver link should show its generated PIN once to the authorized admin.");
  await cdp.evaluate(`document.querySelector('[data-testid="fleet-driver-pin-once"]')?.closest("section")?.querySelector("button")?.click()`);
  const firstSavedRequest = await cdp.evaluate(`(async () => {
    const response = await fetch("/api/admin/fleet/cards?view=requests&page=1&pageSize=50&search=TEST-UI-VEHICLE-01", { credentials: "include" });
    const data = await response.json().catch(() => ({}));
    const item = Array.isArray(data.items) ? data.items.find(row => row.plate === "TEST-UI-VEHICLE-01") : null;
    return { status: response.status, id: item?.id ?? "", vehicleId: item?.vehicleId ?? "", organizationId: item?.organizationId ?? "", fulfillmentMethod: item?.fulfillmentMethod ?? "" };
  })()`);
  assert.equal(firstSavedRequest.status, 200, "The persisted pickup request should be readable after creation.");
  assert.match(firstSavedRequest.id, /^[0-9a-f-]{36}$/i);
  assert.match(firstSavedRequest.vehicleId, /^[0-9a-f-]{36}$/i);
  assert.equal(firstSavedRequest.fulfillmentMethod, "pickup");
  const savedDriver = await cdp.evaluate(`(async () => {
    const response = await fetch("/api/admin/fleet/catalog?view=drivers&page=1&pageSize=50&search=" + encodeURIComponent("سائق اختبار معزول"), { credentials: "include" });
    const data = await response.json().catch(() => ({}));
    const item = Array.isArray(data.items) ? data.items[0] : null;
    return { status: response.status, id: item?.id ?? "" };
  })()`);
  assert.equal(savedDriver.status, 200);
  assert.match(savedDriver.id, /^[0-9a-f-]{36}$/i, "The newly created driver should exist exactly once in the driver list.");
  const directoryIdentity = await cdp.evaluate(`(async () => {
    const vehiclesResponse = await fetch("/api/admin/fleet/catalog?view=vehicles&page=1&pageSize=50&search=TEST-UI-VEHICLE-01", { credentials: "include" });
    const driversResponse = await fetch("/api/admin/fleet/catalog?view=drivers&page=1&pageSize=50&search=" + encodeURIComponent("سائق اختبار معزول"), { credentials: "include" });
    const vehicles = await vehiclesResponse.json();
    const drivers = await driversResponse.json();
    const vehicle = vehicles.items?.find(item => item.id === ${JSON.stringify(firstSavedRequest.vehicleId)});
    const driver = drivers.items?.find(item => item.id === ${JSON.stringify(savedDriver.id)});
    return { vehicle, driver };
  })()`);
  assert.match(directoryIdentity.vehicle?.photoDocumentId ?? "", /^[0-9a-f-]{36}$/i, "Vehicle directory must expose the uploaded private photo identity without a storage URL.");
  const linkedDirectoryVehicle = directoryIdentity.driver?.activeVehicles?.find(item => item.id === firstSavedRequest.vehicleId);
  assert.equal(linkedDirectoryVehicle?.plate, "TEST-UI-VEHICLE-01", "Driver directory must identify its assigned vehicle.");
  assert.equal(linkedDirectoryVehicle?.photoDocumentId, directoryIdentity.vehicle.photoDocumentId, "Driver and vehicle directories must refer to the same protected photo.");
  assert.ok(!JSON.stringify(directoryIdentity).includes("storage_path") && !JSON.stringify(directoryIdentity).includes("signedURL"), "Directory data must not contain private storage locations.");
  await navigate(`/admin/fleet/drivers/${savedDriver.id}`, "ملف السائق");
  await waitForSelector('button[data-pair-link-id]');
  const originalPairLinkId = await cdp.evaluate(`document.querySelector('button[data-pair-link-id]')?.getAttribute("data-pair-link-id") ?? ""`);
  assert.match(originalPairLinkId, /^[0-9a-f-]{36}$/i, "The active driver link should be identifiable for isolated verification.");
  assert.equal(await cdp.evaluate(`document.querySelectorAll('input[id^="driver-pin-reason-"]').length`), 0, "PIN reveal does not ask for a manual reason");
  await clickButtonText("عرض الرمز");
  await waitForSelector(".fleet-pin-value code");
  const revealedPinIsFourDigits = await cdp.evaluate(`/^\\d{4}$/.test(document.querySelector(".fleet-pin-value code")?.textContent?.trim() ?? "")`);
  assert.equal(revealedPinIsFourDigits, true, "Authorized admin should be able to reveal the active pair PIN without a manual reason; the read remains audited.");
  assert.ok((await cdp.evaluate("document.body?.innerText ?? ''")).includes("سُجل عرض الرمز في سجل التدقيق"));
  await assertResponsiveLayout();

  await navigate("/admin/cards", "إدارة البطاقات");
  await waitForText("ملخص سجلات التعريف");
  assert.equal(await cdp.evaluate('document.querySelectorAll(".fc-tabs button").length'), 5);
  await clickButtonText("طلبات التعريف");
  await waitForSelector(".fc-details-button");
  assert.ok((await cdp.evaluate("document.body?.innerText ?? ''")).includes("TEST-UI-VEHICLE-01"));
  await cdp.evaluate(`document.querySelector(".fc-details-button")?.click()`);
  const requestDetail = await waitForText("مكتب استقبال الفرع");
  assert.ok(!requestDetail.includes("مسؤول اختبار معزول") && requestDetail.includes("استلام من الفرع"));
  assert.ok(requestDetail.includes("سجل حركة التعريف على المركبة"));
  const centerRequestReference = await cdp.evaluate(`document.querySelector("#fc-request-detail-title")?.textContent?.trim() ?? ""`);
  const requestContextLinks = await cdp.evaluate(`([...document.querySelectorAll(".fc-request-links a")].map(link => new URL(link.href).pathname))`);
  assert.equal(centerRequestReference, `طلب-${firstSavedRequest.id.replaceAll("-", "").slice(-8).toUpperCase()}`);
  assert.ok(requestContextLinks.includes(`/admin/fleet/vehicles/${firstSavedRequest.vehicleId}`));
  assert.ok(requestContextLinks.includes(`/admin/organizations/${firstSavedRequest.organizationId}`));
  await waitForSelector(".fc-request-history");
  await navigate(`/admin/organizations/${firstSavedRequest.organizationId}`, "API Fleet");
  const organizationDetail = await cdp.evaluate(`fetch(${JSON.stringify(`/api/organizations/${firstSavedRequest.organizationId}`)}, { credentials: "include" }).then(async response => ({ status: response.status, body: await response.json() }))`);
  assert.equal(organizationDetail.status, 200);
  assert.equal(organizationDetail.body.kind, "company", `The scoped organization response must retain its type: ${JSON.stringify(organizationDetail.body)}`);
  await clickTabText("الأسطول", ".co-entity-tabs");
  await waitForText("أسطول الشركة");
  await clickTabText("طلبات التعريف", '[data-testid="organization-fleet-panel"]');
  await waitForSelector(`[data-testid="fleet-card-requests-company"] [data-request-id="${firstSavedRequest.id}"]`);
  const companyRequestProof = await cdp.evaluate(`(() => {
    const id = ${JSON.stringify(firstSavedRequest.id)};
    const rows = [...document.querySelectorAll('[data-testid="fleet-card-requests-company"] [data-testid="fleet-card-request-row"]')].filter(row => row.getAttribute("data-request-id") === id);
    return { count: rows.length, reference: rows[0]?.querySelector('[data-testid="fleet-card-request-reference"]')?.textContent?.trim() ?? "" };
  })()`);
  assert.equal(companyRequestProof.count, 1, "The company file should show the same request once.");
  assert.equal(companyRequestProof.reference, centerRequestReference);
  await navigate(`/admin/fleet/vehicles/${firstSavedRequest.vehicleId}`, "TEST-UI-VEHICLE-01");
  await waitForSelector(`[data-testid="fleet-card-requests-vehicle"] [data-request-id="${firstSavedRequest.id}"]`);
  const vehicleRequestProof = await cdp.evaluate(`(() => {
    const id = ${JSON.stringify(firstSavedRequest.id)};
    const rows = [...document.querySelectorAll('[data-testid="fleet-card-requests-vehicle"] [data-testid="fleet-card-request-row"]')].filter(row => row.getAttribute("data-request-id") === id);
    return { count: rows.length, reference: rows[0]?.querySelector('[data-testid="fleet-card-request-reference"]')?.textContent?.trim() ?? "" };
  })()`);
  assert.equal(vehicleRequestProof.count, 1, "The vehicle file should show the same request once.");
  assert.equal(vehicleRequestProof.reference, centerRequestReference);
  await navigate("/admin/cards", "إدارة البطاقات");
  await waitForText("ملخص سجلات التعريف");
  await clickTabText("طلبات التعريف", ".fc-tabs");
  await waitForSelector(".fc-details-button");
  const reopenFirstRequest = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll("tr")].find(item => item.innerText.includes("TEST-UI-VEHICLE-01"));
    const button = row?.querySelector(".fc-details-button");
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(reopenFirstRequest, true);
  await waitForSelector(".fc-request-detail");
  setStorageSignFailure();
  await cdp.evaluate(`document.querySelector(".fc-request-links a")?.click()`);
  await waitForText("صور المركبة والعداد");
  await cdp.evaluate('document.querySelector(".fleet-private-image-grid")?.scrollIntoView({ block: "center" })');
  await waitForText("تعذر فتح الصورة الخاصة");
  const retryPhotoPreview = await cdp.evaluate(`(() => {
    const failedFigure = [...document.querySelectorAll(".fleet-private-image")]
      .find(figure => figure.querySelector('.fleet-private-image-empty[role="alert"]'));
    const button = failedFigure?.querySelector("figcaption button");
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(retryPhotoPreview, true, "A failed private image preview should expose a retry action.");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const loaded = await cdp.evaluate(`(() => [...document.querySelectorAll(".fleet-private-image img")].filter(image => image.complete && image.naturalWidth > 0).length)()`);
    if (loaded >= 2) break;
    await delay(100);
  }
  const loadedPrivateImages = await cdp.evaluate(`(() => [...document.querySelectorAll(".fleet-private-image img")].filter(image => image.complete && image.naturalWidth > 0).length)()`);
  const privateImageDiagnostics = await cdp.evaluate(`(() => [...document.querySelectorAll(".fleet-private-image")].map(figure => ({
    message: figure.querySelector(".fleet-private-image-empty")?.innerText ?? "",
    image: figure.querySelector("img") ? {
      src: figure.querySelector("img").currentSrc,
      complete: figure.querySelector("img").complete,
      naturalWidth: figure.querySelector("img").naturalWidth,
    } : null,
  })))()`);
  const imageNetworkDiagnostics = cdp.storageImageEvents().map(item => ({
    path: new URL(item.url).pathname,
    status: item.status,
    mimeType: item.mimeType,
    errorText: item.errorText,
    blockedReason: item.blockedReason,
  }));
  assert.equal(loadedPrivateImages, 2, `Vehicle and odometer photos should reload from isolated private storage: ${JSON.stringify({ privateImageDiagnostics, imageNetworkDiagnostics })}`);
  await cdp.evaluate(`(() => { const button = document.querySelector(".fleet-private-image-zoom"); button?.focus(); button?.click(); })()`);
  await waitForSelector(".fleet-image-lightbox[role=dialog]");
  assert.equal(await cdp.evaluate('document.querySelector(".fleet-image-lightbox")?.matches(":modal")'), true, "Private image zoom must use a modal dialog with native focus containment.");
  assert.equal(await cdp.evaluate('document.activeElement === document.querySelector(".fleet-image-lightbox button")'), true, "Image close action must receive keyboard focus.");

  await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  assert.equal(await cdp.evaluate('Boolean(document.querySelector(".fleet-image-lightbox"))'), false, "Image zoom dialog should close with Escape.");
  assert.equal(await cdp.evaluate('document.activeElement?.classList.contains("fleet-private-image-zoom")'), true, "Closing an image must restore focus to its thumbnail.");

  await cdp.evaluate("location.reload()");
  await waitForText("صور المركبة والعداد");
  await cdp.evaluate('document.querySelector(".fleet-private-image-grid")?.scrollIntoView({ block: "center" })');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const loaded = await cdp.evaluate(`(() => [...document.querySelectorAll(".fleet-private-image img")].filter(image => image.complete && image.naturalWidth > 0).length)()`);
    if (loaded >= 2) break;
    await delay(100);
  }
  assert.equal(await cdp.evaluate(`(() => [...document.querySelectorAll(".fleet-private-image img")].filter(image => image.complete && image.naturalWidth > 0).length)()`), 2);
  await assertResponsiveLayout();
  await navigate("/admin/fleet/vehicles", "المركبات");
  await waitForSelector('[data-testid="fleet-record-search"]');
  await setValue('[data-testid="fleet-record-search"]', "TEST-UI-VEHICLE-01");
  await waitForSelector('[data-testid="row-fleet-vehicles-1"] .fleet-private-image-zoom');
  await cdp.evaluate('document.querySelector(\'[data-testid="row-fleet-vehicles-1"] .fleet-private-image-zoom\')?.click()');
  await waitForSelector(".fleet-image-lightbox[open]");
  assert.equal(await cdp.evaluate("location.pathname"), "/admin/fleet/vehicles", "Opening a directory image must not navigate away from the list.");
  await cdp.evaluate('document.querySelector(".fleet-image-lightbox button")?.click()');
  await assertResponsiveLayout();
  await navigate("/admin/fleet/drivers", "السائقون");
  await waitForSelector('[data-testid="fleet-record-search"]');
  await setValue('[data-testid="fleet-record-search"]', "سائق اختبار معزول");
  await waitForSelector('[data-testid="row-fleet-drivers-1"] .fleet-private-image-zoom');
  assert.ok((await cdp.evaluate('document.querySelector(\'[data-testid="row-fleet-drivers-1"]\')?.innerText ?? ""')).includes("TEST-UI-VEHICLE-01"), "Driver list must display its active vehicle plate.");
  await assertResponsiveLayout();
  await navigate("/admin/cards", "إدارة البطاقات");
  await waitForText("ملخص سجلات التعريف");
  await clickButtonText("طلبات التعريف");
  await waitForSelector(".fc-details-button");
  await cdp.evaluate(`document.querySelector(".fc-details-button")?.click()`);
  await waitForText("طلب-");
  await waitForText("سجل حركة التعريف على المركبة");
  await cdp.evaluate(`document.querySelector(".fc-detail-close")?.click()`);
  await navigate("/admin/fleet/vehicles/new", "إضافة مركبة");
  await setValue('input[name="plateOriginal"]', "TEST-UI-VEHICLE-02");
  await setValue('input[name="category"]', "خصوصي تجريبي");
  await setValue('input[name="vehicleType"]', "سيارة ركوب تجريبية");
  await setValue('select[name="fuelType"]', fuelOption);
  await setValue('input[name="brand"]', "مصنّع تجريبي");
  await setValue('input[name="model"]', "طراز تجريبي");
  await clickButtonText("التالي");
  await setValue('[data-testid="fleet-reference-organizationId-input"]', "API Fleet");
  await waitForSelector('[data-testid="fleet-reference-organizationId-option-0"]');
  await cdp.evaluate(`document.querySelector('[data-testid="fleet-reference-organizationId-option-0"]')?.click()`);
  await setValue('[data-testid="fleet-reference-branchId-input"]', "API");
  await waitForSelector('[data-testid="fleet-reference-branchId-option-0"]');
  await cdp.evaluate(`document.querySelector('[data-testid="fleet-reference-branchId-option-0"]')?.click()`);
  await clickButtonText("التالي");
  await setValue('select[name="credentialType"]', "nfc");
  await setValue('select[name="fulfillmentMethod"]', "install");
  await setValue('input[name="installationAddress"]', "موقع التركيب التجريبي المعزول");
  await setValue('input[name="fulfillmentContactName"]', "مسؤول تركيب اختبار");
  await setValue('input[name="fulfillmentContactPhone"]', "+201000000998");
  await clickButtonText("التالي");
  const installReview = await waitForText("مراجعة قبل الحفظ");
  assert.ok(installReview.includes("تركيب بالموقع") && installReview.includes("موقع التركيب التجريبي المعزول"));
  await clickButtonText("إنشاء المركبة");
  await waitForText("تم إنشاء المركبة");
  const savedInstallRequest = await cdp.evaluate(`(async () => {
    const response = await fetch("/api/admin/fleet/cards?view=requests&page=1&pageSize=50&search=TEST-UI-VEHICLE-02", { credentials: "include" });
    const data = await response.json().catch(() => ({}));
    const item = Array.isArray(data.items) ? data.items.find(row => row.plate === "TEST-UI-VEHICLE-02") : null;
    return { status: response.status, id: item?.id ?? "", vehicleId: item?.vehicleId ?? "", fulfillmentMethod: item?.fulfillmentMethod ?? "", address: item?.installationAddress ?? "" };
  })()`);
  assert.equal(savedInstallRequest.status, 200);
  assert.match(savedInstallRequest.vehicleId, /^[0-9a-f-]{36}$/i);
  assert.equal(savedInstallRequest.fulfillmentMethod, "install");
  assert.equal(savedInstallRequest.address, "موقع التركيب التجريبي المعزول");
  await navigate("/admin/cards", "إدارة البطاقات");
  await waitForText("ملخص سجلات التعريف");
  await clickButtonText("طلبات التعريف");
  await waitForSelector(".fc-details-button");
  const openInstallDetail = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll("tr")].find(item => item.innerText.includes("TEST-UI-VEHICLE-02"));
    const button = row?.querySelector(".fc-details-button");
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(openInstallDetail, true, "Saved installation request should be reachable from the request list.");
  const installDetail = await waitForText("موقع التركيب التجريبي المعزول");
  assert.ok(installDetail.includes("مسؤول تركيب اختبار") && installDetail.includes("تركيب بالموقع"));
  await cdp.evaluate(`document.querySelector(".fc-detail-close")?.click()`);
  const invalidFulfillmentStatuses = await cdp.evaluate(`Promise.all([
    "/api/admin/fleet/cards?view=requests&fulfillmentMethod=unknown",
    "/api/admin/fleet/cards?view=issued&fulfillmentMethod=pickup"
  ].map(url => fetch(url, { credentials: "include" }).then(response => response.status)))`);
  assert.deepEqual(invalidFulfillmentStatuses, [400, 400], "Invalid or inapplicable fulfillment filters must fail explicitly.");
  async function assertFulfillmentFilter(method, includedId, excludedId) {
    await cdp.evaluate(`document.querySelector('[data-testid="fc-requests-${method}"]')?.click()`);
    let matched = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      matched = await cdp.evaluate(`(() => {
        const rows = [...document.querySelectorAll("tr[data-request-id]")].map(row => row.dataset.requestId);
        return rows.includes(${JSON.stringify(includedId)}) && !rows.includes(${JSON.stringify(excludedId)}) && !document.querySelector(".fc-skeleton");
      })()`);
      if (matched) break;
      await delay(100);
    }
    assert.equal(matched, true, `The ${method} request tab must show its persisted request and exclude the other method.`);
    const result = await cdp.evaluate(`fetch("/api/admin/fleet/cards?view=requests&fulfillmentMethod=${method}&page=1&pageSize=1", { credentials: "include" }).then(async response => ({ status: response.status, body: await response.json() }))`);
    assert.equal(result.status, 200);
    assert.ok(result.body.total >= 1 && result.body.items.length === 1);
    assert.ok(result.body.items.every(item => item.fulfillmentMethod === method), "Pagination must filter on the server.");
  }
  await assertFulfillmentFilter("install", savedInstallRequest.id, firstSavedRequest.id);
  await assertFulfillmentFilter("pickup", firstSavedRequest.id, savedInstallRequest.id);
  await assertResponsiveLayout();
  await cdp.evaluate('document.querySelector(\'[data-testid="fc-requests-all"]\')?.click()');

  await navigate(`/admin/fleet/vehicles/${firstSavedRequest.vehicleId}`, "ملف المركبة");
  await waitForText("TEST-UI-VEHICLE-01");
  await waitForSelector('[data-testid^="fleet-driver-link-end-"]');
  const endDriverLinkButton = await cdp.evaluate(`(() => {
    const button = document.querySelector('[data-testid^="fleet-driver-link-end-"]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(endDriverLinkButton, true, "Vehicle profile must expose an authorized action to end the current driver assignment.");
  await waitForSelector('[data-testid="fleet-command-submit"]');
  await cdp.evaluate(`document.querySelector('[data-testid="fleet-command-submit"]')?.click()`);
  await waitForText("تم إرسال الإجراء إلى الخادم وتسجيله");
  await navigate(`/admin/fleet/vehicles/${savedInstallRequest.vehicleId}`, "ملف المركبة");
  await waitForText("TEST-UI-VEHICLE-02");
  await waitForSelector(".fleet-vehicle-driver-actions");
  const openDriverLinkForm = await cdp.evaluate(`(() => {
    const button = document.querySelector('[data-testid="fleet-driver-link-create"]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(openDriverLinkForm, true, "The vehicle profile should expose the authorized driver-link action.");
  await waitForSelector('[data-testid="fleet-reference-driverId-input"]');
  await setValue('[data-testid="fleet-reference-driverId-input"]', "سائق اختبار معزول");
  await waitForSelector('[data-testid="fleet-reference-driverId-option-0"]');
  await cdp.evaluate(`document.querySelector('[data-testid="fleet-reference-driverId-option-0"]')?.click()`);
  const startDateInput = await cdp.evaluate(`Boolean(document.querySelector('input[name="startsAt"]'))`);
  if (startDateInput) await setValue('input[name="startsAt"]', cairoLocalDateTime(-240));
  const pinField = await cdp.evaluate(`Boolean(document.querySelector('input[name="pinCode"]'))`);
  if (pinField) await setValue('input[name="pinCode"]', "");
  await cdp.evaluate(`document.querySelector('[data-testid="fleet-command-submit"]')?.click()`);
  await waitForSelector('[data-testid="fleet-driver-pin-once"]');
  const reassignedDriverPairPin = await cdp.evaluate(`document.querySelector('[data-testid="fleet-driver-pin-once"]')?.textContent?.trim() ?? ""`);
  const relinkPinIsFourDigits = /^\d{4}$/.test(reassignedDriverPairPin);
  assert.equal(relinkPinIsFourDigits, true, "Reassigning the driver should create a new pair PIN and show it once.");
  await navigate(`/admin/fleet/drivers/${savedDriver.id}`, "ملف السائق");
  await waitForText("TEST-UI-VEHICLE-01");
  await waitForText("TEST-UI-VEHICLE-02");
  const activePairLinkId = await cdp.evaluate(`document.querySelector('button[data-pair-link-id]')?.getAttribute("data-pair-link-id") ?? ""`);
  assert.match(activePairLinkId, /^[0-9a-f-]{36}$/i, "Only the current driver link should expose PIN reveal.");
  assert.notEqual(activePairLinkId, originalPairLinkId, "Reassignment should replace the active link.");
  assert.equal(await cdp.evaluate(`Boolean(document.querySelector('[data-pair-link-id="${originalPairLinkId}"]'))`), false, "The ended driver link must not expose PIN reveal.");
  await clickButtonText("عرض الرمز");
  await waitForSelector(".fleet-pin-value code");
  const revealedReassignedPin = await cdp.evaluate(`document.querySelector(".fleet-pin-value code")?.textContent?.trim() ?? ""`);
  assert.equal(revealedReassignedPin, reassignedDriverPairPin, "The new PIN must be the only one recoverable for the active link.");
  const oldPairRequest = JSON.stringify({
    linkId: originalPairLinkId,
    vehicleId: firstSavedRequest.vehicleId,
    pinCode: initialDriverPairPin,
  });
  const oldPairVerification = await cdp.evaluate(`(async () => {
    const response = await fetch("/api/admin/fleet/driver-pairs/verify", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: ${JSON.stringify(oldPairRequest)},
    });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, valid: data.valid, locked: data.locked };
  })()`);
  assert.equal(oldPairVerification.status, 200);
  assert.equal(oldPairVerification.valid, false, "The old pair PIN must stop verifying after reassignment.");
  const driverHistory = await cdp.evaluate("document.body?.innerText ?? ''");
  assert.ok(driverHistory.includes("TEST-UI-VEHICLE-01") && driverHistory.includes("TEST-UI-VEHICLE-02"), "Driver profile should retain both ended and current vehicle assignments.");
  await cdp.evaluate("location.reload()");
  await waitForText("ملف السائق");
  await waitForText("TEST-UI-VEHICLE-01");
  await waitForText("TEST-UI-VEHICLE-02");
  await navigate("/admin/cards", "إدارة البطاقات");
  await waitForText("ملخص سجلات التعريف");
  await clickButtonText("طلبات التعريف");
  await waitForSelector(".fc-details-button");
  const savedRequestsAfterReload = await cdp.evaluate(`(() => [...document.querySelectorAll("tr")].filter(row =>
    row.innerText.includes("TEST-UI-VEHICLE-01") || row.innerText.includes("TEST-UI-VEHICLE-02")).length)()`);
  assert.equal(savedRequestsAfterReload, 2, "Pickup and installation requests should persist once each after reload.");
  assert.equal(await cdp.evaluate('Boolean(document.querySelector(".fc-primary-actions button")?.innerText.includes("طلب تعريف لمركبة"))'), true);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  const cardsScreenshot = (await cdp.send("Page.captureScreenshot", {
    format: "png", captureBeyondViewport: false,
  })).data;
  await clickButtonText("طلب تعريف لمركبة");
  await waitForSelector('[data-testid="fleet-reference-vehicleId-input"]');
  await setValue('[data-testid="fleet-reference-vehicleId-input"]', "TEST-UI-VEHICLE-01");
  await waitForSelector('[data-testid="fleet-reference-vehicleId-option-0"]');
  await cdp.evaluate(`document.querySelector('[data-testid="fleet-reference-vehicleId-option-0"]')?.click()`);
  await setValue('select[name="credentialType"]', "qr");
  await setValue('select[name="requestType"]', "issue");
  await clickButtonText("حفظ الإجراء");
  await waitForText("تم إرسال الإجراء إلى الخادم وتسجيله");
  const createdQrRequest = await cdp.evaluate(`(async () => {
    const response = await fetch("/api/admin/fleet/cards?view=requests&page=1&pageSize=50&search=TEST-UI-VEHICLE-01", { credentials: "include" });
    const data = await response.json().catch(() => ({}));
    const item = Array.isArray(data.items) ? data.items.find(row => row.plate === "TEST-UI-VEHICLE-01" && row.type === "qr") : null;
    return { status: response.status, id: item?.id ?? "", type: item?.type ?? "", requestType: item?.requestType ?? "", state: item?.status ?? "" };
  })()`);
  assert.equal(createdQrRequest.status, 200);
  assert.match(createdQrRequest.id, /^[0-9a-f-]{36}$/i);
  assert.equal(createdQrRequest.type, "qr");
  assert.equal(createdQrRequest.requestType, "issue");
  assert.equal(createdQrRequest.state, "requested");
  const openQrApproval = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll(".fc-table-wrap tbody tr")].find(item =>
      item.innerText.includes("TEST-UI-VEHICLE-01") && item.innerText.includes("رمز QR"));
    const button = [...(row?.querySelectorAll("button") ?? [])].find(item => item.innerText.trim() === "اعتماد الطلب");
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(openQrApproval, true, "The saved QR request should expose its authorized approval action.");
  await waitForSelector('[data-testid="fleet-command-submit"]');
  await clickButtonText("حفظ الإجراء");
  await waitForText("تم إرسال الإجراء إلى الخادم وتسجيله");
  await waitForSelector(".fc-table-wrap tbody tr .fc-status.status-approved");
  const openQrActivation = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll(".fc-table-wrap tbody tr")].find(item =>
      item.innerText.includes("TEST-UI-VEHICLE-01") && item.innerText.includes("رمز QR"));
    const button = [...(row?.querySelectorAll("button") ?? [])].find(item => item.innerText.trim() === "إصدار QR");
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(openQrActivation, true, "An approved QR request should expose its one-time logical issuance action.");
  await waitForSelector('[data-testid="fleet-command-submit"]');
  await clickButtonText("حفظ الإجراء");
  await waitForSelector('[data-testid="fleet-token-hide"]');
  await cdp.evaluate(`document.querySelector('[data-testid="fleet-token-hide"]')?.click()`);
  await cdp.evaluate("location.reload()");
  await waitForText("ملخص سجلات التعريف");
  await clickButtonText("طلبات التعريف");
  await waitForSelector(".fc-details-button");
  const requestsAfterQrReload = await cdp.evaluate(`(() => [...document.querySelectorAll(".fc-table-wrap tbody tr")].filter(row =>
    row.innerText.includes("TEST-UI-VEHICLE-01") || row.innerText.includes("TEST-UI-VEHICLE-02")).length)()`);
  assert.equal(requestsAfterQrReload, 3, "Pickup, installation, and QR requests should each persist once after reload.");
  await clickButtonText("البطاقات الصادرة");
  await waitForSelector(".fc-table-wrap tbody tr");
  const activeQrCard = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll(".fc-table-wrap tbody tr")].find(item =>
      item.innerText.includes("TEST-UI-VEHICLE-01") && item.innerText.includes("رمز QR"));
    return { found: Boolean(row), active: Boolean(row?.querySelector(".fc-status.status-active")) };
  })()`);
  assert.deepEqual(activeQrCard, { found: true, active: true }, "An issued QR should appear as active in the saved-card list.");
  const openQrStop = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll(".fc-table-wrap tbody tr")].find(item =>
      item.innerText.includes("TEST-UI-VEHICLE-01") && item.innerText.includes("رمز QR"));
    const button = [...(row?.querySelectorAll("button") ?? [])].find(item => item.innerText.trim() === "إيقاف البطاقة");
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(openQrStop, true, "The active QR should expose an authorized stop action.");
  await waitForSelector('[data-testid="fleet-reference-credentialId-input"]');
  await setValue('[data-testid="fleet-reference-credentialId-input"]', "رمز");
  await waitForSelector('[data-testid="fleet-reference-credentialId-option-0"]');
  await cdp.evaluate(`document.querySelector('[data-testid="fleet-reference-credentialId-option-0"]')?.click()`);
  await clickButtonText("حفظ الإجراء");
  await waitForSelector(".fc-table-wrap tbody tr .fc-status.status-revoked");
  const revokedQrCard = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll(".fc-table-wrap tbody tr")].find(item =>
      item.innerText.includes("TEST-UI-VEHICLE-01") && item.innerText.includes("رمز QR"));
    const status = row?.querySelector(".fc-status");
    return { found: Boolean(row), revoked: Boolean(status?.classList.contains("status-revoked")), label: status?.innerText ?? "" };
  })()`);
  assert.deepEqual(revokedQrCard, { found: true, revoked: true, label: "مبطل" }, "Stopping the QR should persist in Arabic as a non-active card state.");
  await cdp.evaluate("location.reload()");
  await waitForText("ملخص سجلات التعريف");
  await clickButtonText("البطاقات الصادرة");
  await waitForSelector(".fc-table-wrap tbody tr .fc-status.status-revoked");
  assert.equal(await cdp.evaluate(`(() => [...document.querySelectorAll(".fc-table-wrap tbody tr")].some(item =>
    item.innerText.includes("TEST-UI-VEHICLE-01") && item.innerText.includes("رمز QR") && item.querySelector(".fc-status.status-revoked")?.innerText === "مبطل"))()`), true);
  await clickButtonText("البطاقات غير الفعالة");
  await waitForSelector(".fc-table-wrap tbody tr .fc-status.status-revoked");
  assert.equal(await cdp.evaluate('document.querySelector(".fc-state-tabs button[aria-pressed=true]")?.dataset.testid'), "fc-issued-inactive");
  assert.equal(await cdp.evaluate('document.querySelectorAll(".fc-table-wrap .fc-status.status-active").length'), 0);
  await clickButtonText("البطاقات الفعالة");
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await cdp.evaluate('!document.querySelector(".fc-skeleton") && !document.querySelector(".fc-table-wrap .fc-status.status-revoked")')) break;
    await delay(100);
  }
  assert.equal(await cdp.evaluate('document.querySelectorAll(".fc-table-wrap .fc-status.status-revoked").length'), 0);
  await clickButtonText("كل البطاقات");
  await clickButtonText("مخزون الشرائح");
  await waitForText("حجوزات الشرائح القابلة للاستكمال");
  assert.equal(await cdp.evaluate('Boolean(document.querySelector(".fc-primary-actions button")?.innerText.includes("تسجيل استلام شرائح"))'), true);
  await clickButtonText("سجل الحركة");
  const cardActivityResponse = await cdp.evaluate(`(async () => {
    const response = await fetch("/api/admin/fleet/cards?view=history&page=1&pageSize=50", { credentials: "include" });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, body: data, total: data.total, items: Array.isArray(data.items) ? data.items.map(item => ({ action: item.action, plate: item.plate })) : [], pageText: (document.body?.innerText ?? "").slice(-800) };
  })()`);
  assert.equal(cardActivityResponse.status, 200, `Card activity endpoint should be readable by the isolated owner: ${JSON.stringify(cardActivityResponse)}`);
  assert.ok(
    Number(cardActivityResponse.total) >= 2
      && cardActivityResponse.items.some(item => item.plate === "TEST-UI-VEHICLE-01")
      && cardActivityResponse.items.some(item => item.plate === "TEST-UI-VEHICLE-02"),
    `Both saved onboarding card requests should appear in the activity view: ${JSON.stringify(cardActivityResponse)}`,
  );
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await cdp.evaluate('document.querySelectorAll(".fc-table-wrap tbody tr").length > 0')) break;
    await delay(100);
  }
  assert.ok(await cdp.evaluate('document.querySelectorAll(".fc-table-wrap tbody tr").length > 0'), `Card activity should show persisted audit events for the saved isolated requests: ${JSON.stringify(await cdp.evaluate("document.body?.innerText ?? ''"))}`);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
  });
  assert.equal(await cdp.evaluate('!document.querySelector(".ac-sidebar")?.classList.contains("drawer-open")'), true);
  await click(".ac-mobile-menu");
  assert.equal(await cdp.evaluate('document.querySelector(".ac-sidebar")?.classList.contains("drawer-open")'), true);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await settleResponsiveLayout();
  assert.equal(await cdp.evaluate('getComputedStyle(document.querySelector(".ac-sidebar")).visibility'), "hidden", "Escape must close and hide mobile navigation");
  assert.equal(await cdp.evaluate('document.activeElement?.classList.contains("ac-mobile-menu")'), true, "Escape restores focus to the navigation trigger");
  await click(".ac-mobile-menu");
  await click('a[href="/admin/plans"]');
  await waitForText("الخطط والإصدارات");
  assert.equal(await cdp.evaluate('!document.querySelector(".ac-sidebar")?.classList.contains("drawer-open")'), true);
  await navigate("/admin/cards", "إدارة البطاقات");
  await waitForText("ملخص سجلات التعريف");
  await assertResponsiveLayout();
  for (const [route, label, firstHeader] of [["vehicles", "المركبات", "رقم اللوحة"], ["drivers", "السائقون", "اسم السائق"]]) {
    await navigate(`/admin/fleet/${route}`, label);
    await waitForSelector(`[data-testid="row-fleet-${route}-1"]`);
    const headers = await cdp.evaluate('[...document.querySelectorAll(".fleet-record-table th")].map(cell => cell.innerText.trim())');
    const identityHeader = route === "vehicles" && headers[0] === "صورة المركبة" ? headers[1] : headers[0];
    assert.ok(identityHeader?.includes(firstHeader), `Directory must lead with useful identity, alongside its photo: ${JSON.stringify(headers)}`);
    assert.ok(!headers.includes("كود السائق"), "Internal generated driver codes must not crowd the directory.");
    await assertResponsiveLayout();
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await settleResponsiveLayout();
    await cdp.evaluate('document.querySelector(".fleet-record-table")?.scrollIntoView({block:"start"})');
    assert.equal(await cdp.evaluate('getComputedStyle(document.querySelector(".fleet-record-table tbody tr")).display'), "block", "Mobile fleet rows must render as readable cards.");
    await writeFile(path.join(os.tmpdir(), `pertomax-fleet-${route}-mobile.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })).data, "base64"));
    await cdp.send("Emulation.clearDeviceMetricsOverride");
  }
  await navigate("/admin/workforce","تكليفات العمال");
  await waitForSelector('[data-testid="workforce-organization-input"]');
  await setValue('[data-testid="workforce-organization-input"]',"API Billing");
  await waitForSelector('[data-testid="workforce-organization-option-0"]');
  await cdp.evaluate('document.querySelector(\'[data-testid="workforce-organization-option-0"]\')?.click()');
  await waitForSelector('[data-testid="workforce-branch-input"]');
  await setValue('[data-testid="workforce-branch-input"]',"API");
  await waitForSelector('[data-testid="workforce-branch-option-0"]');
  await cdp.evaluate('document.querySelector(\'[data-testid="workforce-branch-option-0"]\')?.click()');
  await waitForSelector('[data-testid="workforce-user"] option[value]:not([value=""])');
  const workerOption=await cdp.evaluate('document.querySelector(\'[data-testid="workforce-user"] option[value]:not([value=""])\')?.value');
  assert.ok(workerOption);
  await setValue('[data-testid="workforce-user"]',workerOption);
  await setValue('[data-testid="workforce-service"]',"wash");
  assert.equal(await cdp.evaluate('document.querySelector(\'[data-testid="workforce-service"] option[value="fuel"]\')?.disabled'),true,"Provider fuel must be disabled in the form.");
  await cdp.evaluate('document.querySelector(\'[data-testid="workforce-submit"]\')?.click()');
  await waitForText("حُفظ التكليف");
  await cdp.evaluate("location.reload()");
  await waitForSelector('[data-testid="workforce-row"]');
  assert.equal(await cdp.evaluate(`[...document.querySelectorAll('[data-testid="workforce-row"]')].some(row=>row.innerText.includes("الغسيل")&&row.innerText.includes("مسموح ضمن الخدمة"))`),true,"Browser assignment must persist after reload.");
  await assertResponsiveLayout();


  const overviewProbe=await cdp.evaluate('(async()=>{const r=await fetch("/api/admin/organization-requests",{credentials:"include"});const d=await r.json();return {status:r.status,items:d.items,message:d.message};})()');
  assert.equal(overviewProbe.status,200,"Overview inbox must be read from real isolated RLS tables: "+JSON.stringify(overviewProbe));
  assert.ok(Array.isArray(overviewProbe.items));
  await navigate("/admin","لوحة التشغيل");
  await waitForSelector('[data-testid="overview-metric"] strong');
  for(let i=0;i<100;i++){
   const state=await cdp.evaluate('({n:document.querySelectorAll(\'[data-testid="overview-metric"] strong\').length,error:document.querySelectorAll(\'[data-testid="overview-metric"] [role="alert"]\').length})');
   if(state.n===3&&state.error===0)break;
   await delay(100);
  }
  assert.equal(await cdp.evaluate('document.querySelectorAll(\'[data-testid="overview-metric"] strong\').length'),3);
  assert.equal(await cdp.evaluate('document.querySelectorAll(\'[data-testid="overview-metric"] [role="alert"]\').length'),0,"Do not accept dashboard screenshots with data read errors");

  const inboxCopy=await cdp.evaluate('document.querySelector(".ac-inbox-list")?.innerText??""');
  assert.doesNotMatch(inboxCopy,/pending_review|vehicle_photo|odometer_evidence/,"Overview must show Arabic review states and document names");
  assert.match(inboxCopy,/صورة المركبة/);
  assert.match(inboxCopy,/صورة العداد/);
  assert.match(inboxCopy,/بانتظار المراجعة/);
  await waitForSelector(".ac-quick-link");
  assert.equal(await cdp.evaluate('document.querySelectorAll(".ac-quick-link").length'),6);
  for(const width of [1365,390]){
   await cdp.send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:width<500});
   await settleResponsiveLayout();
   if(width<500)assert.equal(await cdp.evaluate('getComputedStyle(document.querySelector(".ac-sidebar")).visibility'),"hidden","Closed navigation must not cover overview screenshots");
   assert.equal(await cdp.evaluate("document.documentElement.scrollWidth<=innerWidth+2"),true,"Overview must fit mobile and desktop");
   if(width<500){
    const heading=await cdp.evaluate('(()=>{const h=document.querySelector(".ac-overview-heading h1").getBoundingClientRect(),t=document.querySelector(".ac-overview-tools").getBoundingClientRect();return {headingBottom:h.bottom,toolsTop:t.top};})()');
    assert.ok(heading.toolsTop>=heading.headingBottom,"Mobile refresh controls must appear below the heading, not compress its text");
   }
   await writeFile(path.join(os.tmpdir(),"pertomax-fleet-admin-overview-"+(width<500?"mobile":"desktop")+".png"),Buffer.from((await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:true})).data,"base64"));
  }
  await click('.ac-quick-link[href="/admin/plans"]');
  await waitForText("الخطط والإصدارات");
  await navigate("/","أسطولك يتحرك.");
  assert.equal(await cdp.evaluate('document.querySelectorAll(".pm-benefits article").length'),3);
  assert.equal(await cdp.evaluate('document.querySelectorAll(".pm-audience-grid article").length'),3);
  for(const width of [1365,390]){
   await cdp.send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:width<500});
   assert.equal(await cdp.evaluate("document.documentElement.scrollWidth<=innerWidth+2"),true,"Public site must fit mobile and desktop");
   await writeFile(path.join(os.tmpdir(),"pertomax-fleet-public-home-"+(width<500?"mobile":"desktop")+".png"),Buffer.from((await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:true})).data,"base64"));
  }
  await click('.pm-hero-actions a[href="#how-it-works"]');
  assert.equal(await cdp.evaluate("location.hash"),"#how-it-works");
  await click(".pm-hero-actions .pm-primary");
  for(let i=0;i<100;i++){if(await cdp.evaluate("location.pathname")==="/sign-up")break;await delay(50);}
  assert.equal(await cdp.evaluate("location.pathname"),"/sign-up","Primary public action must really open registration");
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  console.log("PASS: revised public home/role/services content, real registration/section navigation and useful dashboard shortcuts fit desktop/mobile with screenshots.");
  return { planName, planCode, fuelName, fuelCode, cardViews: 5, cardsScreenshot, vehicleId: firstSavedRequest.vehicleId, requestId: firstSavedRequest.id };
}


async function runWorkerVerificationBrowser(cdp,webPort,fixture){
  async function waitForText(text, timeout = 20_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const body = await cdp.evaluate("document.body?.innerText ?? ''");
      if (body?.includes(text)) return body;
      await delay(200);
    }
    const body = await cdp.evaluate("document.body?.innerText ?? ''");
    throw new Error(`UI did not show "${text}". Current page text:\n${String(body).slice(0, 2000)}`);
  }

  async function waitForSelector(selector) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) return;
      await delay(100);
    }
    const diagnostics = await cdp.evaluate(`(async () => ({
      url: location.pathname,
      page: (document.body?.innerText ?? "").slice(-1800),
      pickerStates: [...document.querySelectorAll(".fleet-reference-state")].map((item) => item.innerText),
      organizationInputs: [...document.querySelectorAll('[data-testid="fleet-reference-organizationId-input"]')].map((input) => ({
        expanded: input.getAttribute("aria-expanded"),
        active: input === document.activeElement,
        value: input.value
      })),
      organizationProbe: await fetch("/api/organizations?page=1&pageSize=20&kind=company&sortBy=name&sortDirection=asc", { credentials: "include" })
        .then(async (response) => {
          const data = await response.json().catch(() => ({}));
          const first = Array.isArray(data.items) ? data.items[0] : null;
          return {
            status: response.status,
            keys: Object.keys(data),
            count: Array.isArray(data.items) ? data.items.length : null,
            firstItem: first ? { id: first.id, name: first.name, kind: first.kind } : null,
            message: data.message
          };
        })
        .catch((error) => ({ error: String(error) }))
    }))()`);
    throw new Error(`UI did not render selector ${selector}: ${JSON.stringify(diagnostics)}`);
  }

  async function setValue(selector, value) {
    const expression = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const prototype = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
        : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(el, ${JSON.stringify(value)});
      else el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`;
    assert.equal(await cdp.evaluate(expression), true, `Missing form field ${selector}`);
  }


 await cdp.send("Page.navigate",{url:`http://127.0.0.1:${webPort}/operations`});
 await waitForSelector('[data-testid="operations-assignment"] option');
 const selected=await cdp.evaluate('document.querySelector(\'[data-testid="operations-assignment"]\')?.value');
 assert.ok(selected,"Worker must see only a real executable assignment.");
 assert.equal(await cdp.evaluate('document.querySelector(\'[data-testid="operations-pin"]\')?.type'),"password");
 await setValue('[data-testid="operations-token"]',fixture.token);
 await setValue('[data-testid="operations-pin"]',fixture.pin);
 assert.equal(await cdp.evaluate('document.body.innerText.includes('+JSON.stringify(fixture.pin)+')'),false,"PIN must never be rendered as body text.");
 await cdp.evaluate('document.querySelector(\'[data-testid="operations-verify"]\')?.click()');
 await waitForSelector('[data-testid="operations-proof"]');
 assert.equal(await cdp.evaluate('document.querySelector(\'[data-testid="operations-pin"]\')?.value'),"","Submitted PIN must immediately clear.");
 assert.equal(await cdp.evaluate('document.querySelector(\'[data-testid="operations-token"]\')?.value'),"","Successful credential must clear.");
 assert.equal(await cdp.evaluate('document.querySelector(\'[data-testid="operations-proof"]\')?.innerText.includes('+JSON.stringify(fixture.plate)+')'),true);
 assert.equal(await cdp.evaluate('(async()=>{const response=await fetch("/api/admin/workforce",{credentials:"include"});return response.status;})()'),403,"Worker session must not gain central administration.");
 if(fixture.quote){
  await waitForSelector('[data-testid="quote-item"] option');
  await setValue('[data-testid="quote-value"]',"100");
  await cdp.evaluate('document.querySelector(\'[data-testid="quote-submit"]\')?.click()');
  await waitForSelector('[data-testid="quote-result"]');
  assert.equal(await cdp.evaluate('document.querySelector(\'[data-testid="quote-total"]\')?.innerText'),"100.00 جنيه");
  assert.equal(await cdp.evaluate('document.querySelector(\'[data-testid="quote-result"]\')?.innerText.includes("متاح ضمن الحدود الحالية")'),true,"Actual scoped quote must pass coverage/policy/funding checks.");
 }

 for(const width of [390,768,1365]){
  await cdp.send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:width<500});
  await delay(150);
  assert.equal(await cdp.evaluate('document.documentElement.scrollWidth<=innerWidth+2'),true,"Worker page must fit each viewport.");
 }
 await writeFile(path.join(os.tmpdir(),"pertomax-fleet-operations-desktop.png"),Buffer.from((await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:true})).data,"base64"));
 await cdp.send("Emulation.setDeviceMetricsOverride",{width:390,height:900,deviceScaleFactor:1,mobile:true});
 if(fixture.quote){
  await cdp.evaluate('document.querySelector(\'[data-testid="order-reserve"]\')?.click()');
  await waitForSelector('[data-testid="order-reserve"]:not([disabled])');
  for(let i=0;i<100;i++){if(await cdp.evaluate('document.querySelector(\'[data-testid="order-reserve"]\')?.innerText.includes("التحقق من نتيجة الحجز")'))break;await delay(50);}
  assert.equal(await cdp.evaluate('document.querySelector(\'[data-testid="order-reserve"]\')?.innerText'),"التحقق من نتيجة الحجز","A lost commit response must retain the original booking attempt.");
  assert.equal(await cdp.evaluate('document.querySelector(\'[data-testid="operations-assignment"]\')?.disabled'),true);
  await cdp.evaluate('document.querySelector(\'[data-testid="order-reserve"]\')?.click()');
  await waitForSelector('[data-testid="order-detail"]');
  assert.equal(await cdp.evaluate('document.querySelector(\'[data-testid="order-detail"]\')?.innerText.includes("المبلغ محجوز")'),true);
  const orderUrl=await cdp.evaluate("location.href");
  const previousDocument=await cdp.evaluate("performance.timeOrigin");
  await cdp.send("Page.reload");
  for(let i=0;i<100;i++){if(await cdp.evaluate("performance.timeOrigin")!==previousDocument)break;await delay(50);}
  assert.notEqual(await cdp.evaluate("performance.timeOrigin"),previousDocument,"Reload must create a new document before querying its order controls.");
  await waitForSelector('[data-testid="order-detail"]');
  assert.equal(await cdp.evaluate("location.href"),orderUrl);
  await cdp.evaluate('document.querySelector(\'[data-testid="order-cancel"]\')?.click()');
  for(let i=0;i<100;i++){if(await cdp.evaluate('document.querySelector(\'[data-testid="order-cancel"]\')?.innerText.includes("التحقق من نتيجة الإلغاء")'))break;await delay(50);}
  assert.equal(await cdp.evaluate('document.querySelector(\'[data-testid="order-cancel"]\')?.innerText'),"التحقق من نتيجة الإلغاء","An uncertain cancellation must retry the same command.");
  await cdp.evaluate('document.querySelector(\'[data-testid="order-cancel"]\')?.click()');
  await waitForSelector('[data-testid="order-cancelled"]');
  assert.equal(await cdp.evaluate('document.querySelector(\'[data-testid="order-detail"]\')?.innerText.includes("غير مدفوع")'),true);
  assert.equal(await cdp.evaluate('document.querySelector(\'[data-testid="order-cancel"]\')===null'),true);

  // New real UI order: start, upload meter image, record partial actual delivery.
  await cdp.send("Page.navigate",{url:`http://127.0.0.1:${webPort}/operations`});
  await waitForSelector('[data-testid="operations-assignment"] option');
  await setValue('[data-testid="operations-token"]',fixture.token);
  await setValue('[data-testid="operations-pin"]',fixture.pin);
  await cdp.evaluate('document.querySelector(\'[data-testid="operations-verify"]\')?.click()');
  await waitForSelector('[data-testid="operations-proof"]');
  await waitForSelector('[data-testid="quote-item"] option');
  await setValue('[data-testid="quote-value"]',"100");
  await cdp.evaluate('document.querySelector(\'[data-testid="quote-submit"]\')?.click()');
  await waitForSelector('[data-testid="quote-result"]');
  await cdp.evaluate('document.querySelector(\'[data-testid="order-reserve"]\')?.click()');
  await waitForSelector('[data-testid="execution-start"]');
  await cdp.evaluate('document.querySelector(\'[data-testid="execution-start"]\')?.click()');
  await waitForSelector('[data-testid="execution-deliver"]');
  await setValue('[data-testid="execution-quantity"]',"7");
  await setValue('[data-testid="execution-reading"]',"2000");
  const root=(await cdp.send("DOM.getDocument")).root.nodeId;
  const inputNode=(await cdp.send("DOM.querySelector",{nodeId:root,selector:'[data-testid="evidence-file-odometer"]'})).nodeId;
  assert.ok(inputNode,"Actual execution needs an odometer file input.");
  await cdp.send("DOM.setFileInputFiles",{nodeId:inputNode,files:[fixture.imagePath]});
  await cdp.evaluate('document.querySelector(\'[data-testid="evidence-upload-odometer"]\')?.click()');
  await waitForSelector('[data-testid="evidence-open-odometer"]');
  await cdp.evaluate('document.querySelector(\'[data-testid="evidence-open-odometer"]\')?.click()');
  await waitForSelector('[role="dialog"] img');
  assert.equal(await cdp.evaluate('document.querySelector(\'[role="dialog"] img\')?.alt'),"صورة العداد");
  await cdp.evaluate('document.querySelector(\'[role="dialog"] button\')?.click()');
  await cdp.evaluate('document.querySelector(\'[data-testid="execution-deliver"]\')?.click()');
  await waitForSelector('[data-testid="execution-retry"]');
  await cdp.evaluate('document.querySelector(\'[data-testid="execution-retry"]\')?.click()');
  await waitForSelector('[data-testid="execution-delivered"]');
  assert.equal(await cdp.evaluate('document.querySelector(\'[data-testid="execution-delivered"]\')?.innerText.includes("لم يُسجّل دفع نهائي")'),true);
  const executedUrl=await cdp.evaluate("location.href");
  const documentBefore=await cdp.evaluate("performance.timeOrigin");
  await cdp.send("Page.reload");
  for(let i=0;i<100;i++){if(await cdp.evaluate("performance.timeOrigin")!==documentBefore)break;await delay(50);}
  await waitForSelector('[data-testid="execution-delivered"]');
  assert.equal(await cdp.evaluate("location.href"),executedUrl);
  const actual=await cdp.evaluate('(async()=>{const id=location.pathname.split("/").pop();return (await fetch("/api/operations/service-orders/"+id+"/execution",{credentials:"include"})).json();})()');
  assert.equal(actual.delivery.actualQuantity,"7");
  assert.equal(actual.delivery.actualAmountMinor,"8750");
  assert.equal(actual.paymentStatus,"held");
  assert.equal(actual.evidence.filter(e=>e.status==="accepted").length,1);
  assert.equal(await cdp.evaluate('document.querySelector(\'[data-testid="order-cancel"]\')===null'),true,"Physical execution cannot be cancelled as a draft.");
  console.log("PASS: worker UI started actual service, uploaded/viewed a private odometer image, recovered lost delivery response and reloaded one immutable partial delivery with payment still held.");


  await waitForSelector('[data-testid="payment-confirm"]');
  assert.equal(await cdp.evaluate('document.querySelector(\'[data-testid="payment-pin"]\')?.type'),"password");
  await setValue('[data-testid="payment-pin"]',"٠٠٤٢");
  await cdp.evaluate('document.querySelector(\'[data-testid="payment-confirm"]\')?.click()');
  await waitForSelector('[data-testid="payment-uncertain"]');
  assert.equal(await cdp.evaluate('document.querySelector(\'[data-testid="payment-pin"]\')?.value'),"","PIN must be cleared even when committed response is lost");
  await setValue('[data-testid="payment-pin"]',"0042");
  await cdp.evaluate('document.querySelector(\'[data-testid="payment-confirm"]\')?.click()');
  await waitForSelector('[data-testid="payment-paid"]');
  await waitForSelector('[data-testid="payment-receipt"]');
  const receiptNumber=await cdp.evaluate('document.querySelector(\'[data-testid="payment-receipt"] header b\')?.innerText');
  assert.match(receiptNumber,/^SR-\d{4}-\d{8,}$/);
  const paymentBeforeReload=await cdp.evaluate("performance.timeOrigin");
  await cdp.send("Page.reload");
  for(let i=0;i<100;i++){if(await cdp.evaluate("performance.timeOrigin")!==paymentBeforeReload)break;await delay(50);}
  await waitForSelector('[data-testid="payment-paid"]');
  assert.equal(await cdp.evaluate('document.querySelector(\'[data-testid="payment-receipt"] header b\')?.innerText'),receiptNumber);
  assert.equal(await cdp.evaluate('document.querySelector(\'[data-testid="payment-pin"]\')===null'),true);
  const finalState=await cdp.evaluate('(async()=>{const id=location.pathname.split("/").pop();return(await fetch("/api/operations/service-orders/"+id+"/payment",{credentials:"include"})).json()})()');
  assert.equal(finalState.paid,true);assert.equal(finalState.payment.chargedAmountMinor,"8750");assert.equal(finalState.payment.releasedAmountMinor,"1250");

  await cdp.send("Emulation.setEmulatedMedia",{media:"print"});
  const printVisibility=await cdp.evaluate('({receipt:getComputedStyle(document.querySelector(".so-receipt")).visibility,button:getComputedStyle(document.querySelector(\'[data-testid="payment-print"]\')).display})');
  assert.equal(printVisibility.receipt,"visible");assert.equal(printVisibility.button,"none");
  const printed=await cdp.send("Page.printToPDF",{printBackground:true,preferCSSPageSize:true});
  const receiptPDF=Buffer.from(printed.data,"base64");
  assert.ok(receiptPDF.subarray(0,5).equals(Buffer.from("%PDF-")),"Receipt must really produce a PDF");
  assert.equal((receiptPDF.toString("latin1").match(/\/Type\s*\/Page\b/g)??[]).length,1,"Receipt print must not include a second blank application page");
  await writeFile(path.join(os.tmpdir(),"pertomax-fleet-order-receipt.pdf"),receiptPDF);
  await cdp.send("Emulation.setEmulatedMedia",{media:"screen"});

  console.log("PASS: browser final PIN is masked/cleared, committed lost response retries same command, actual payment/receipt persist after reload.");

  for(const width of [390,768,1365]){
   await cdp.send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:width<500});
   assert.equal(await cdp.evaluate("document.documentElement.scrollWidth<=innerWidth+2"),true,"Order details must fit each viewport.");
  }
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1365,height:900,deviceScaleFactor:1,mobile:false});
  await writeFile(path.join(os.tmpdir(),"pertomax-fleet-order-desktop.png"),Buffer.from((await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:true})).data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:390,height:900,deviceScaleFactor:1,mobile:true});
  await writeFile(path.join(os.tmpdir(),"pertomax-fleet-order-mobile.png"),Buffer.from((await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:true})).data,"base64"));
  console.log("PASS: worker browser reserved actual funds, recovered lost booking/cancellation responses, reloaded persisted state and released holds once with no payment or delivery claim.");
 }
 if(fixture.quote)await cdp.evaluate('document.querySelector(\'[data-testid="quote-result"]\')?.scrollIntoView({block:"center"})');
 await delay(100);
 await writeFile(path.join(os.tmpdir(),"pertomax-fleet-operations-mobile.png"),Buffer.from((await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false})).data,"base64"));
 await cdp.send("Emulation.clearDeviceMetricsOverride");
 console.log("PASS: worker browser verified a leading-zero PIN, masked/cleared secrets, scoped access and responsive layouts using disposable fixtures.");
}


async function runRefundIntakeBrowser(cdp,webPort,orderId,workerPort){
 async function navigate(url){
  const previous=await cdp.evaluate("performance.timeOrigin");
  if(url)await cdp.send("Page.navigate",{url});else await cdp.send("Page.reload");
  for(let i=0;i<200;i++){
   if(await cdp.evaluate('performance.timeOrigin!=='+JSON.stringify(previous)+'&&document.readyState!=="loading"'))return;
   await delay(50);
  }
  throw new Error("Refund browser document transition did not complete");
 }

 async function wait(selector){
  for(let i=0;i<200;i++){if(await cdp.evaluate("!!document.querySelector("+JSON.stringify(selector)+")"))return;await delay(100);}
  throw new Error("Refund browser missing "+selector+": "+await cdp.evaluate("document.body.innerText.slice(-3000)"));
 }
 await navigate("http://127.0.0.1:"+webPort+"/admin/service-orders/"+encodeURIComponent(orderId));
 await wait('[data-testid="refund-submit"]');
 await cdp.evaluate('(()=>{const e=document.querySelector(\'[data-testid="refund-amount"]\');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,"٢٥");e.dispatchEvent(new Event("input",{bubbles:true}));})()');
 await cdp.evaluate('document.querySelector(\'[data-testid="refund-submit"]\').click()');
 await wait('[data-testid="refund-retry"]');
 await cdp.evaluate('document.querySelector(\'[data-testid="refund-retry"]\').click()');
 await wait('[data-testid="refund-withdraw"]');
 const before=await cdp.evaluate('(async()=>{const r=await fetch("/api/admin/service-orders/"+location.pathname.split("/").pop()+"/refunds",{credentials:"include"});return r.json();})()');
 assert.equal(before.items.length,1);assert.equal(before.requestedAmountMinor,"2500");assert.equal(before.remainingRequestableMinor,"6250");assert.equal(before.financialRefundEnabled,true);
 await navigate();
 await wait('[data-testid="refund-withdraw"]');
 await cdp.evaluate('document.querySelector(\'[data-testid="refund-withdraw"]\').click()');
 for(let i=0;i<100;i++){if(await cdp.evaluate('document.querySelector(\'[data-testid="refund-request"]\')?.innerText.includes("مسحوب")'))break;await delay(100);}
 const after=await cdp.evaluate('(async()=>{const id=location.pathname.split("/").pop();const r=await fetch("/api/admin/service-orders/"+id+"/refunds",{credentials:"include"});const p=await fetch("/api/admin/service-orders/"+id+"/payment",{credentials:"include"});return {refund:await r.json(),payment:await p.json()};})()');
 assert.equal(after.refund.items.length,1);assert.equal(after.refund.items[0].status,"withdrawn");assert.equal(after.refund.requestedAmountMinor,"0");assert.equal(after.refund.remainingRequestableMinor,"8750");assert.equal(after.payment.paid,true);

 // Preserve the entire disposable PostgreSQL cluster before committed monetary tests.
 // Production rollback must refuse financial history; the runner later resets only its isolated fixture.
 const archive=process.env.PERTOMAX_BEFORE_REFUND_SNAPSHOT;
 assert.ok(archive?.startsWith("/tmp/pertomax-db01.")&&process.env.PGHOST?.startsWith("/tmp/pertomax-db01.")&&process.env.PGDATABASE==="postgres","Financial browser snapshot is allowed only in the disposable test cluster");
 execFileSync("pg_basebackup",["--pgdata",archive,"--checkpoint=fast","--wal-method=stream"],{env:process.env,timeout:30000,stdio:["ignore","ignore","pipe"]});
 await cdp.evaluate('(()=>{const e=document.querySelector(\'[data-testid="refund-amount"]\');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,"٢٥");e.dispatchEvent(new Event("input",{bubbles:true}));})()');
 await cdp.evaluate('document.querySelector(\'[data-testid="refund-submit"]\').click()');
 await wait('[data-testid="refund-decide"]');
 await cdp.evaluate('(()=>{const e=document.querySelector(\'[data-testid="refund-decision-amount"]\');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,"١٠");e.dispatchEvent(new Event("input",{bubbles:true}));})()');
 await cdp.evaluate('document.querySelector(\'[data-testid="refund-decide"]\').click()');
 await wait('[data-testid="refund-retry"]');
 await cdp.evaluate('document.querySelector(\'[data-testid="refund-retry"]\').click()');
 await wait('[data-testid="refund-credit-open"]');
 const moneyView=await cdp.evaluate('(async()=>{const r=await fetch("/api/admin/service-orders/"+location.pathname.split("/").pop()+"/refunds",{credentials:"include"});return r.json();})()');
 assert.equal(moneyView.refundedAmountMinor,"1000");assert.equal(moneyView.remainingRequestableMinor,"7750");assert.equal(moneyView.items.filter(r=>r.status==="refunded").length,1);
 const paidAgain=await cdp.evaluate('(async()=>{const r=await fetch("/api/admin/service-orders/"+location.pathname.split("/").pop()+"/payment",{credentials:"include"});return r.json();})()');assert.equal(paidAgain.paid,true);assert.equal(paidAgain.payment.chargedAmountMinor,"8750");
 await navigate();await wait('[data-testid="refund-credit-open"]');
 await cdp.evaluate('document.querySelector(\'[data-testid="refund-credit-open"]\').click()');await wait('[data-testid="refund-credit-document"]');
 const creditNumber=await cdp.evaluate('document.querySelector(\'[data-testid="refund-credit-document"] header b\')?.innerText');assert.match(creditNumber,/^SC-\d{4}-\d{8,}$/);
 await cdp.send("Emulation.setEmulatedMedia",{media:"print"});
 const creditPDF=Buffer.from((await cdp.send("Page.printToPDF",{printBackground:true,preferCSSPageSize:true})).data,"base64");
 assert.equal((creditPDF.toString("latin1").match(/\/Type\s*\/Page\b/g)??[]).length,1,"Credit document must print alone on one A4 page");
 await writeFile(path.join(os.tmpdir(),"pertomax-fleet-refund-credit.pdf"),creditPDF);
 await cdp.send("Emulation.setEmulatedMedia",{media:"screen"});
 await cdp.send("Emulation.setDeviceMetricsOverride",{width:390,height:900,deviceScaleFactor:1,mobile:true});
 assert.equal(await cdp.evaluate("document.documentElement.scrollWidth<=innerWidth+2"),true);
 await writeFile(path.join(os.tmpdir(),"pertomax-fleet-refund-credit-mobile.png"),Buffer.from((await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:true})).data,"base64"));
 await cdp.evaluate('document.querySelector(\'[data-testid="refund-credit-document"] button\')?.click()');
 console.log("PASS: actual browser Finance partial refund credits original funding, recovers a lost committed decision with one journal/document, reloads immutable credit and prints one real A4 page.");
 for(const width of [390,1365]){
  await cdp.send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:width<500});
  await cdp.evaluate('(async()=>{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const s=document.querySelector(".ac-sidebar");if(s)await Promise.all(s.getAnimations().map(a=>a.finished.catch(()=>{})));})()');
  assert.equal(await cdp.evaluate("document.documentElement.scrollWidth<=innerWidth+2"),true,"Refund workflow must fit mobile/desktop");
  await writeFile(path.join(os.tmpdir(),"pertomax-fleet-refund-"+(width<500?"mobile":"desktop")+".png"),Buffer.from((await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:true})).data,"base64"));
 }
 await cdp.send("Emulation.clearDeviceMetricsOverride");
 await navigate("http://127.0.0.1:"+workerPort+"/operations/orders/"+encodeURIComponent(orderId));
 await wait('[data-testid="refund-decision"]');
 const workerRead=await cdp.evaluate('(async()=>{const r=await fetch("/api/service-orders/"+location.pathname.split("/").pop()+"/refunds",{credentials:"include"});return {status:r.status,body:await r.json()};})()');
 assert.equal(workerRead.status,200);assert.equal(workerRead.body.refundedAmountMinor,"1000");assert.equal(workerRead.body.canRequest,false);
 assert.ok(workerRead.body.items.every(r=>!r.canWithdraw&&!r.canDecide),"Original worker reads credits without money or request controls");
 assert.equal(await cdp.evaluate('!!document.querySelector(\'[data-testid="refund-submit"],[data-testid="refund-withdraw"],[data-testid="refund-decide"]\')'),false);
 await navigate();await wait('[data-testid="refund-credit-open"]');
 await cdp.send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:false});
 assert.equal(await cdp.evaluate("document.documentElement.scrollWidth<=innerWidth+2"),true,"Worker refund history must fit mobile");
 const workerBounds=await cdp.evaluate('(()=>({width:innerWidth,clientWidth:document.documentElement.clientWidth,bounds:[...document.querySelectorAll(".so-heading,.so-heading h1,.so-detail,.so-refund-panel")].map(e=>{const r=e.getBoundingClientRect();return {element:e.tagName,left:r.left,right:r.right};})}))()');
 assert.ok(workerBounds.bounds.every(r=>r.left>=-1&&r.right<=workerBounds.width+1),"Worker headings and panels must fit visible viewport: "+JSON.stringify(workerBounds));
 await cdp.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 const workerLayout=await cdp.send("Page.getLayoutMetrics");
 await writeFile(path.join(os.tmpdir(),"pertomax-fleet-refund-worker-mobile.png"),Buffer.from((await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:true,clip:{x:0,y:0,width:390,height:Math.ceil(workerLayout.cssContentSize.height),scale:1}})).data,"base64"));
 await cdp.evaluate('document.querySelector(\'[data-testid="refund-credit-open"]\').click()');await wait('[data-testid="refund-credit-document"]');
 assert.equal(await cdp.evaluate('document.querySelector(\'[data-testid="refund-credit-document"]\').innerText.includes("أُعيد المبلغ")'),true);
 await cdp.evaluate('document.querySelector(\'[data-testid="refund-credit-document"] button\').click()');
 await cdp.send("Emulation.clearDeviceMetricsOverride");
 console.log("PASS: original worker sees actual refund history and immutable credit after reload with no request/withdraw/decision controls on mobile.");
 console.log("PASS: actual browser creates a partial refund request with Arabic digits, retries the same committed lost response, reloads and withdraws without changing payment or stock.");
}

export async function runAdminUiLocalSmoke({ repoRoot, apiPort, projectRef, ownerId, setStorageSignFailure, workerVerification }) {
  const webPort = await reservePort();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pertomax-admin-ui-"));
  const syntheticPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jTE0AAAAASUVORK5CYII=", "base64");
  const vehicleImagePath = path.join(tempDir, "synthetic-vehicle.png");
  const odometerImagePath = path.join(tempDir, "synthetic-odometer.png");
  await Promise.all([writeFile(vehicleImagePath, syntheticPng), writeFile(odometerImagePath, syntheticPng)]);
  const viteOutput = [];
  const auth = makeAuthCookie(projectRef, ownerId);
  const env = {
    ...process.env,
    PORT: String(webPort),
    BASE_PATH: "/",
    VITE_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
    TEST_API_PROXY_COOKIE: `${auth.name}=${auth.value}`,
  };
  delete env.REPL_ID;
  const webRoot = path.join(repoRoot, "artifacts/pertomax-eg-web");
  const vite = spawn(
    path.join(webRoot, "node_modules/.bin/vite"),
    ["--config", "vite.config.ts", "--host", "127.0.0.1", "--port", String(webPort)],
    { cwd: webRoot, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  vite.stdout.on("data", (chunk) => viteOutput.push(String(chunk)));
  vite.stderr.on("data", (chunk) => viteOutput.push(String(chunk)));

  let chrome;
  let workerVite;
  let socket;
  const browserOutput = [];
  try {
    await waitForHttp(`http://127.0.0.1:${webPort}/`, vite, viteOutput);
    const chromePath = process.env.CHROMIUM_PATH ?? "google-chrome";
    let activePortText;
    for(let attempt=0;attempt<2;attempt++){
      const profile=path.join(tempDir,"chrome-"+attempt);
      const browserEnv={...process.env};
      delete browserEnv.DBUS_SESSION_BUS_ADDRESS;
      chrome = spawn(chromePath, [
        "--headless=new","--no-sandbox","--disable-gpu","--disable-dev-shm-usage",
        "--no-first-run","--no-default-browser-check","--disable-background-networking","--disable-extensions",
        "--remote-allow-origins=*","--remote-debugging-address=127.0.0.1","--remote-debugging-port=0",
        `--user-data-dir=${profile}`,"about:blank",
      ],{env:browserEnv,stdio:["ignore","ignore","pipe"]});
      chrome.stderr.on("data",chunk=>{browserOutput.push(String(chunk));if(browserOutput.length>100)browserOutput.shift();});
      chrome.on("error",error=>browserOutput.push(String(error)));
      try{activePortText=await waitForFile(path.join(profile,"DevToolsActivePort"),chrome,browserOutput);break;}
      catch(error){await stopChild(chrome);if(attempt===1)throw error;}
    }
    if(!activePortText)throw new Error("Browser did not expose an isolated DevTools port");
    const debugPort = Number(activePortText.split(/\r?\n/)[0]);
    const target = await httpJson(`http://127.0.0.1:${debugPort}/json/new?about:blank`, "PUT");
    assert.equal(target.status, 200);
    socket = new WebSocket(target.body.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const cdp = createCdp(socket);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    const { cardsScreenshot, ...result } = await runBrowserSteps(cdp, webPort, {
      vehicleImagePath,
      odometerImagePath,
      setStorageSignFailure,
    });
    if (cardsScreenshot) {
      const screenshotPath = path.join(os.tmpdir(), "pertomax-admin-cards-ui-smoke.png");
      await writeFile(screenshotPath, Buffer.from(cardsScreenshot, "base64"));
      console.log(`Admin cards smoke screenshot: ${screenshotPath}`);
    }
    console.log("Admin UI local browser smoke passed: plan/fuel edits persisted; two isolated vehicles, a linked driver with one-time PIN reveal/relink, policy, odometer, and private images were saved; after reassignment, the old PIN was rejected and only the new active PIN could be revealed; upload failure retried without duplicating the vehicle; NFC pickup and installation requests persisted with reloadable details; an isolated QR request was approved, issued, hidden without logging its token, then revoked and reloaded in Arabic; private-image preview retry/zoom, mobile drawer, and responsive layouts were checked with a synthetic owner session, disposable PostgreSQL, and isolated in-memory private storage.");
    if(workerVerification){
      const workerPort=await reservePort();
      const workerAuth=makeAuthCookie(projectRef,workerVerification.workerId);
      workerVite=spawn(path.join(webRoot,"node_modules/.bin/vite"),["--config","vite.config.ts","--host","127.0.0.1","--port",String(workerPort)],{
       cwd:webRoot,env:{...env,PORT:String(workerPort),TEST_API_PROXY_COOKIE:`${workerAuth.name}=${workerAuth.value}`},stdio:["ignore","pipe","pipe"]
      });
      workerVite.stdout.on("data",chunk=>viteOutput.push(String(chunk)));
      workerVite.stderr.on("data",chunk=>viteOutput.push(String(chunk)));
      await waitForHttp(`http://127.0.0.1:${workerPort}/`,workerVite,viteOutput);
      await runWorkerVerificationBrowser(cdp,workerPort,{...workerVerification,imagePath:odometerImagePath});
      if(workerVerification.quote){
       const orderId=await cdp.evaluate('location.pathname.split("/").pop()');
       await runRefundIntakeBrowser(cdp,webPort,orderId,workerPort);
      }
    }
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}\nLocal Vite output:\n${viteOutput.join("").slice(-4000)}`);
  } finally {
    socket?.close();
    await Promise.all([stopChild(chrome), stopChild(vite), stopChild(workerVite)]);
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
}
