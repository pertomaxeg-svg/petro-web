# Internal usage reservation core — 0032

Prerequisite for service-order reservation; not an order/payment implementation.
Project `msvgzsfzrqlrfpstthhe`, repository `pertomaxeg-svg/petro-web`, approved branch only;0009 remains deferred.

Extract the existing policy/funding hold algorithm into a private SECURITY INVOKER function with empty search_path and **no** direct anon/authenticated/service_role EXECUTE grant. The existing public service-role-only wrapper retains its original grant, claim check, active legacy proof requirement, proof consumption, payload hash, replay semantics and response shape. No actor impersonation or manufactured service-role claim is added.

The core still serializes by request key and locks vehicle/company branch, checks current coverage, vehicle/branch/service schedules/network/limits and actual tank capacity, then atomically creates usage and finance holds. No ledger capture, merchant credit, order delivery, inventory issue, invoice or settlement occurs here. Future order commands must validate current authenticated actor, assignment and0031 proof themselves before calling the private core; this function deliberately does not grant a public worker entry point.

No table/default ACL, old rows, balance or price is modified by installing the migration. Existing public function is replaced in place, preserving identity/grants. Rollback restores its exact previous definition and drops only the new internal function; existing financial reservations are retained.

RED: run40070191079 / acceptance120801758475, missing shared reservation core as expected.
Require GREEN disposable actual funded hold, missing legacy proof denial, same-request replay, changed-payload conflict, actual finance hold linkage, policy rejection atomicity, private-core client denial and exact original schema/defaultACL restoration. Source/rollback SHA256 fingerprints must be recorded before live application. No live synthetic users, prices or business records.

Source SHA-256: `d3946d2aff2cd2bdee19099030cdb4d9def85c61a9715cc593d5f1c3496da2bb`.
Rollback SHA-256: `30716a7fa3f6bfca1d75010c43795553cb574c1777b3b0982ab514d166fe6fab`.

GREEN: commit6e0519eb3020f2c9786f516c2b450b920647f17b, run40070333103, acceptance120802283933 and real-auth-storage120802284100. All isolated SQL/API/browser and actual Auth/Storage checks passed through0032. The internal-core checks created real disposable finance holds and verified exact original schema/defaultACL rollback. Generated contracts40070333240 have no drift.

Status: acceptance complete and allowlisted; NOT applied live yet.
