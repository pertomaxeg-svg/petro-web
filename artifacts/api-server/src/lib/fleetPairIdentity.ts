import { createHmac } from "node:crypto";
export function fleetHmacSecret(): string | null {
 const value=process.env["SESSION_SECRET"];
 return typeof value==="string"&&value.length>=32?value:null;
}
export function pairPinDigest(vehicleId:string,pinCode:string):string {
 const secret=fleetHmacSecret();
 if(!secret)throw new Error("FLEET_PIN_SECRET_UNAVAILABLE");
 return createHmac("sha256",secret).update("pertomax-eg:fleet:driver-pair:v1\0").update(vehicleId.toLowerCase()).update("\0").update(pinCode).digest("hex");
}
