import assert from "node:assert/strict";
import test from "node:test";
import { reviewStatusLabel, documentTypeLabel, reviewRequestTitle } from "./reviewPresentation.ts";
test("review states are Arabic without changing their meaning",()=>{
 for(const [raw,label] of Object.entries({submitted:"قيد المراجعة",pending:"قيد المراجعة",pending_review:"بانتظار المراجعة",pending_upload:"بانتظار الرفع",approved:"معتمد",rejected:"مرفوض",needs_completion:"تحتاج استكمالًا",withdrawn:"مسحوب",upload_failed:"تعذر الرفع",superseded:"نسخة سابقة",conflict:"تعارض إصدار",draft:"مسودة",attached:"مرفق بالطلب"}))assert.equal(reviewStatusLabel(raw),label);
});
test("unknown states are explicitly unknown, never approved or a raw enum",()=>{
 assert.equal(reviewStatusLabel("future_internal_state"),"حالة غير معروفة");
 assert.equal(reviewStatusLabel(""),"حالة غير معروفة");
});
test("vehicle, driver and odometer document types use recognizable Arabic names",()=>{
 assert.equal(documentTypeLabel("vehicle_photo"),"صورة المركبة");
 assert.equal(documentTypeLabel("odometer_evidence"),"صورة العداد");
 assert.equal(documentTypeLabel("driver_license"),"رخصة القيادة");
});
test("custom document labels and organization names are preserved",()=>{
 assert.equal(documentTypeLabel("تفويض خاص"),"تفويض خاص");
 assert.equal(reviewRequestTitle({requestType:"join",title:"شركة vehicle_photo"}),"شركة vehicle_photo");
});
test("only document-title prefixes are translated",()=>{
 assert.equal(reviewRequestTitle({requestType:"document",title:"مستند vehicle_photo"}),"صورة المركبة");
 assert.equal(reviewRequestTitle({requestType:"document",title:"مستند odometer_evidence"}),"صورة العداد");
 assert.equal(reviewRequestTitle({requestType:"document",title:"مستند تفويض خاص"}),"تفويض خاص");
});

test("user document names matching object prototype keys remain ordinary text",()=>{
 for(const value of ["constructor","__proto__","toString"]){
  assert.equal(documentTypeLabel(value),value);
  assert.equal(reviewStatusLabel(value),"حالة غير معروفة");
 }
});
