// Exact display only: all financial calculations remain integer minor units in SQL.
export function formatOrderMoney(minor:string):string{
 if(!/^[0-9]+$/.test(minor))return "—";
 const value=BigInt(minor);
 const whole=(value/100n).toLocaleString("ar-EG");
 const fraction=(value%100n).toString().padStart(2,"0").replace(/[0-9]/g,d=>String.fromCharCode(1632+Number(d)));
 return whole+"٫"+fraction+" جنيه";
}
