import { createHash } from "node:crypto";
import { basename } from "node:path";
import { Router, type IRouter, type Request, type Response, raw } from "express";
import {
  DownloadCatalogImageParams,
  ExecuteCatalogCommandBody,
  GetCatalogItemParams,
  GetMerchantCatalogItemsQueryParams,
  ListAdminCatalogFuelQueryParams,
  ListAdminCatalogOrganizationsQueryParams,
  PreviewAdminCatalogFuelBody,
  UploadCatalogImageContentParams,
} from "@workspace/api-zod";
import { requireSession } from "./management";
import { isRecord, setNoStore } from "../lib/supabaseServer";

const router: IRouter = Router();
const BUCKET = "petro-private-documents";
const IMAGE_LIMIT = 5 * 1024 * 1024;

type Session = NonNullable<Awaited<ReturnType<typeof requireSession>>>;
type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };

function fail(res: Response, status: number, message: string): void {
  res.status(status).json({ message });
}

function idFrom(req: Request, key: string): string | undefined {
  const value = req.params[key];
  return typeof value === "string" ? value : undefined;
}

function rpc(session: Session, name: string, args?: Record<string, unknown>): Promise<RpcResult> {
  const call = session.supabase.rpc as unknown as (
    functionName: string,
    parameters?: Record<string, unknown>,
  ) => Promise<RpcResult>;
  return call.call(session.supabase, name, args);
}

function mapCatalogError(res: Response, error: { code?: string; message?: string } | null): void {
  const code = error?.code ?? "";
  if (code === "42501" || code === "PGRST301") {
    fail(res, 403, "ليست لديك صلاحية لهذا الإجراء أو لهذا النطاق.");
  } else if (code === "P0002") {
    fail(res, 404, "السجل المطلوب غير موجود أو غير متاح لهذا الحساب.");
  } else if (code === "22023") {
    fail(res, 400, "راجع البيانات المطلوبة ثم أعد المحاولة.");
  } else if (["23505", "23514", "23P01", "40001", "55000"].includes(code)) {
    fail(res, 409, "تعذر الحفظ بسبب تعارض أو شرط غير مستوفى. حدّث البيانات ثم أعد المحاولة.");
  } else if (code === "PGRST202" || code === "42883") {
    fail(res, 503, "إدارة الكتالوج غير مفعلة على قاعدة البيانات الحالية.");
  } else {
    fail(res, 500, "تعذر إكمال الطلب الآن.");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function imageSignatureMatches(contentType: string, bytes: Buffer): boolean {
  if (contentType === "image/png") {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (contentType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  return false;
}

function safeImageName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = basename(value).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return name.length > 0 && name.length <= 160 ? name : null;
}

router.get("/catalog/reference-data", async (req, res) => {
  setNoStore(res);
  const session = await requireSession(req, res, false);
  if (!session) return;
  const { data, error } = await rpc(session, "petro_catalog_reference_data");
  if (error) return mapCatalogError(res, error);
  res.json(asRecord(data));
});

router.get("/admin/catalog/categories", async (req, res) => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const { data, error } = await rpc(session, "petro_catalog_admin_categories");
  if (error) return mapCatalogError(res, error);
  res.json(asRecord(data));
});

router.get("/admin/catalog/organizations", async (req, res) => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const parsed = ListAdminCatalogOrganizationsQueryParams.safeParse(req.query);
  if (!parsed.success) return fail(res, 400, "بيانات البحث والصفحات غير صالحة.");
  const { data, error } = await rpc(session, "petro_catalog_admin_organizations", {
    p_search: parsed.data.search ?? null,
    p_kind: parsed.data.kind ?? null,
    p_page: parsed.data.page,
    p_page_size: parsed.data.pageSize,
  });
  if (error) return mapCatalogError(res, error);
  res.json(asRecord(data));
});

router.get("/admin/catalog/fuel", async (req, res) => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const parsed = ListAdminCatalogFuelQueryParams.safeParse(req.query);
  if (!parsed.success) return fail(res, 400, "بيانات البحث والصفحات غير صالحة.");
  const { data, error } = await rpc(session, "petro_catalog_admin_fuel_list", {
    p_search: parsed.data.search ?? null,
    p_page: parsed.data.page,
    p_page_size: parsed.data.pageSize,
  });
  if (error) return mapCatalogError(res, error);
  res.json(asRecord(data));
});

router.post("/admin/catalog/fuel/preview", async (req, res) => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;
  const parsed = PreviewAdminCatalogFuelBody.safeParse(req.body);
  if (!parsed.success || (parsed.data.quantity === undefined) === (parsed.data.amountMinor === undefined)) {
    return fail(res, 400, "أدخل كمية أو مبلغًا واحدًا فقط لحساب معاينة السعر.");
  }
  const { data, error } = await rpc(session, "petro_catalog_fuel_preview", {
    p_fuel_type_id: parsed.data.fuelTypeId,
    p_quantity: parsed.data.quantity ?? null,
    p_amount_minor: parsed.data.amountMinor ?? null,
  });
  if (error) return mapCatalogError(res, error);
  res.json(asRecord(data));
});

router.get("/admin/catalog/items", async (req, res) => {
  setNoStore(res);
  const session = await requireSession(req, res, false);
  if (!session) return;
  const parsed = GetMerchantCatalogItemsQueryParams.safeParse(req.query);
  if (!parsed.success) return fail(res, 400, "بيانات الجهة أو الفلاتر غير صالحة.");
  const { data, error } = await rpc(session, "petro_catalog_list_items", {
    p_organization_id: parsed.data.organizationId,
    p_branch_id: parsed.data.branchId ?? null,
    p_category_code: parsed.data.categoryCode ?? null,
    p_item_kind: ["product", "service"].includes(parsed.data.kind ?? "") ? parsed.data.kind : null,
    p_status: ["draft", "active", "suspended"].includes(parsed.data.status ?? "") ? parsed.data.status : null,
    p_search: parsed.data.search ?? null,
    p_page: parsed.data.page,
    p_page_size: parsed.data.pageSize,
  });
  if (error) return mapCatalogError(res, error);
  res.json(asRecord(data));
});

router.get("/catalog/items/:itemId", async (req, res) => {
  setNoStore(res);
  const session = await requireSession(req, res, false);
  if (!session) return;
  const parsed = GetCatalogItemParams.safeParse({ itemId: idFrom(req, "itemId") });
  if (!parsed.success) return fail(res, 400, "معرّف الصنف غير صالح.");
  const { data, error } = await rpc(session, "petro_catalog_item_detail", { p_item_id: parsed.data.itemId });
  if (error) return mapCatalogError(res, error);
  res.json(asRecord(data));
});

router.post("/catalog/commands", async (req, res) => {
  setNoStore(res);
  const session = await requireSession(req, res, false);
  if (!session) return;
  const parsed = ExecuteCatalogCommandBody.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "بيانات الإجراء أو سبب التغيير غير مكتملة.");
  const { data, error } = await rpc(session, "petro_catalog_command", {
    p_action: parsed.data.action,
    p_payload: parsed.data.payload,
    p_reason: parsed.data.reason,
    p_idempotency_key: parsed.data.idempotencyKey,
  });
  if (error) return mapCatalogError(res, error);
  res.json(asRecord(data));
});

router.put(
  "/catalog/images/:imageId/content",
  raw({ type: ["image/png", "image/jpeg"], limit: IMAGE_LIMIT }),
  async (req, res) => {
    setNoStore(res);
    const session = await requireSession(req, res, false);
    if (!session) return;
    const parsed = UploadCatalogImageContentParams.safeParse({ imageId: idFrom(req, "imageId") });
    if (!parsed.success || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      return fail(res, 400, "ارفع صورة PNG أو JPEG صالحة.");
    }
    const imageId = parsed.data.imageId;
    const { data: uploadInfo, error: infoError } = await rpc(session, "petro_catalog_image_upload_info", {
      p_image_id: imageId,
    });
    if (infoError) return mapCatalogError(res, infoError);
    const info = asRecord(uploadInfo);
    const bytes = req.body as Buffer;
    const contentType = info["contentType"];
    const byteSize = info["byteSize"];
    const fileName = safeImageName(info["fileName"]);
    const path = info["path"];
    if (typeof path !== "string" || !fileName || typeof contentType !== "string"
      || typeof byteSize !== "number" || byteSize !== bytes.length || byteSize > IMAGE_LIMIT
      || !imageSignatureMatches(contentType, bytes)) {
      await rpc(session, "petro_catalog_image_fail", { p_image_id: imageId });
      return fail(res, 400, "لم تجتز الصورة فحص النوع والحجم وبنية المحتوى.");
    }
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const { error: uploadError } = await session.supabase.storage.from(BUCKET)
      .upload(path, bytes, { contentType, upsert: false, cacheControl: "0" });
    if (uploadError) {
      await rpc(session, "petro_catalog_image_fail", { p_image_id: imageId });
      return fail(res, 502, "تعذر حفظ الصورة في التخزين الخاص. لم يُعلن اكتمال الرفع.");
    }
    const { data: completed, error: completeError } = await rpc(session, "petro_catalog_image_complete", {
      p_image_id: imageId,
      p_sha256: checksum,
    });
    if (completeError) {
      await session.supabase.storage.from(BUCKET).remove([path]);
      await rpc(session, "petro_catalog_image_fail", { p_image_id: imageId });
      return mapCatalogError(res, completeError);
    }
    res.json({ ...asRecord(completed), fileName });
  },
);

router.get("/catalog/images/:imageId/download", async (req, res) => {
  setNoStore(res);
  const session = await requireSession(req, res, false);
  if (!session) return;
  const parsed = DownloadCatalogImageParams.safeParse({ imageId: idFrom(req, "imageId") });
  if (!parsed.success) return fail(res, 400, "معرّف الصورة غير صالح.");
  const { data: image, error } = await rpc(session, "petro_catalog_image_download_info", {
    p_image_id: parsed.data.imageId,
  });
  if (error) return mapCatalogError(res, error);
  const info = asRecord(image);
  const path = info["path"];
  const fileName = safeImageName(info["fileName"]);
  if (typeof path !== "string" || !fileName) return fail(res, 404, "الصورة غير متاحة.");
  const { data, error: linkError } = await session.supabase.storage.from(BUCKET)
    .createSignedUrl(path, 60, { download: fileName });
  if (linkError || !data?.signedUrl) return fail(res, 403, "لا يمكن الوصول إلى الصورة أو انتهت صلاحية الجلسة.");
  res.json({ signedUrl: data.signedUrl, expiresInSeconds: 60, fileName });
});

export default router;
