type ReviewItem={label:string;approved:boolean};
type Version={publicationStatus:string;effectiveAt:string;entitlements:ReviewItem[]|null;settings:ReviewItem[]|null};
export function planPublicationReadiness(version:Version){
 const issues:string[]=[];
 const missingFeatures=!Array.isArray(version.entitlements)||version.entitlements.length===0;
 if(version.publicationStatus!=="draft")issues.push("هذا الإصدار لم يعد مسودة. حدّث سجل الباقة.");
 if(missingFeatures)issues.push("أضف ميزة واحدة على الأقل وحدّد قيمتها واعتمدها قبل النشر.");
 const unapprovedFeatures=(version.entitlements??[]).filter(item=>item.approved!==true);
 const unapprovedSettings=(version.settings??[]).filter(item=>item.approved!==true);
 if(unapprovedFeatures.length)issues.push("اعتمد المميزات: "+unapprovedFeatures.map(item=>item.label||"ميزة بلا اسم").join("، ")+".");
 if(unapprovedSettings.length)issues.push("اعتمد الإعدادات: "+unapprovedSettings.map(item=>item.label||"إعداد بلا اسم").join("، ")+".");
 if(!Number.isFinite(Date.parse(version.effectiveAt)))issues.push("حدّد تاريخ سريان صحيحًا.");
 return {ready:issues.length===0,issues,missingFeatures,unapprovedFeatures:unapprovedFeatures.length,unapprovedSettings:unapprovedSettings.length};
}
