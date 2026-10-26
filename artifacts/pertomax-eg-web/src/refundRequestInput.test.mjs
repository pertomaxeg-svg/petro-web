import assert from "node:assert/strict";import test from "node:test";
import {parseRefundAmount} from "./refundRequestInput.ts";
test("refund amount uses exact piasters and Arabic digits",()=>{assert.equal(parseRefundAmount("٢٥٫٥٠"),"2550");assert.equal(parseRefundAmount("۰.۰۱"),"1");assert.equal(parseRefundAmount(" 100 "),"10000");});
test("zero, negative, grouping, exponents and excess precision cannot request money",()=>{for(const value of ["0","-1","1e3","1,000","1.001","","Infinity","99999999999999999"])assert.equal(parseRefundAmount(value),null,value);});
test("large allowed values never round through a JavaScript number",()=>{assert.equal(parseRefundAmount("9999999999999999.99"),"999999999999999999");});
