const reviewStates: Record<string,string> = {
 draft:"مسودة", submitted:"قيد المراجعة", pending:"قيد المراجعة",
 pending_review:"بانتظار المراجعة", pending_upload:"بانتظار الرفع",
 needs_completion:"تحتاج استكمالًا", approved:"معتمد", rejected:"مرفوض",
 withdrawn:"مسحوب", upload_failed:"تعذر الرفع", superseded:"نسخة سابقة",
 conflict:"تعارض إصدار", attached:"مرفق بالطلب",
};
const documentTypes: Record<string,string> = {
 vehicle_photo:"صورة المركبة", odometer_evidence:"صورة العداد",
 driver_photo:"صورة السائق", driver_license:"رخصة القيادة",
 vehicle_registration:"رخصة المركبة", national_id:"الهوية",
};
export function reviewStatusLabel(value:string):string {
 return reviewStates[value] ?? "حالة غير معروفة";
}
export function documentTypeLabel(value:string):string {
 return documentTypes[value] ?? value;
}
export function reviewRequestTitle(item:{requestType:string;title:string}):string {
 if(item.requestType!=="document")return item.title;
 return documentTypeLabel(item.title.replace(/^مستند\s+/u,""));
}
