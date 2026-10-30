export function parseRefundAmount(value:string):string|null{
 const normalized=value.trim().replace(/[٠-٩]/g,d=>String(d.charCodeAt(0)-1632)).replace(/[۰-۹]/g,d=>String(d.charCodeAt(0)-1776)).replace(/٫/g,".");
 if(!/^[0-9]{1,16}(?:\.[0-9]{1,2})?$/.test(normalized))return null;
 const [whole,fraction=""]=normalized.split(".");
 const minor=BigInt(whole)*100n+BigInt(fraction.padEnd(2,"0"));
 return minor>0n&&minor<=999999999999999999n?minor.toString():null;
}
