import assert from "node:assert/strict";
import test from "node:test";
import { planPublicationReadiness } from "./planPublication.ts";
const draft={publicationStatus:"draft",effectiveAt:"2026-10-26T00:00:00Z",entitlements:[{label:"خدمة معتمدة",approved:true}],settings:[]};
test("empty plan shows actionable missing-feature reason instead of an unexplained publish error",()=>{
 const r=planPublicationReadiness({...draft,entitlements:[]});
 assert.equal(r.ready,false);assert.equal(r.missingFeatures,true);
 assert.match(r.issues.join(" "),/ميزة/);
});
test("unapproved feature and setting are identified by their actual displayed names",()=>{
 const r=planPublicationReadiness({...draft,entitlements:[{label:"التقارير",approved:false}],settings:[{label:"عدد الفروع",approved:false}]});
 assert.equal(r.ready,false);assert.match(r.issues.join(" "),/التقارير/);assert.match(r.issues.join(" "),/عدد الفروع/);
});
test("fully reviewed draft can publish and already published version cannot submit again",()=>{
 assert.equal(planPublicationReadiness(draft).ready,true);
 assert.equal(planPublicationReadiness({...draft,publicationStatus:"published"}).ready,false);
});
test("legacy missing rights and invalid effective date cannot be marked ready",()=>{
 assert.equal(planPublicationReadiness({...draft,entitlements:null}).ready,false);
 assert.equal(planPublicationReadiness({...draft,effectiveAt:"invalid"}).ready,false);
});
