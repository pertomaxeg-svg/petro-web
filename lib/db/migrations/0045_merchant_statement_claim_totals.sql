BEGIN;
-- Additive scoped read correctness only; no financial state or permission changes.
CREATE OR REPLACE FUNCTION public.petro_merchant_statement(p_organization_id uuid DEFAULT NULL,p_branch_id uuid DEFAULT NULL,p_page integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=auth.uid();central boolean;result jsonb;as_of timestamptz:=statement_timestamp();
BEGIN
 IF NOT coalesce(petro_private.workforce_user_active(actor),false) THEN RAISE EXCEPTION 'FORBIDDEN_MERCHANT_STATEMENT' USING ERRCODE='42501';END IF;
 IF p_page IS NULL OR p_page<1 OR p_page>100000 THEN RAISE EXCEPTION 'INVALID_STATEMENT_FILTER' USING ERRCODE='22023';END IF;
 central:=coalesce(petro_private.platform_has(ARRAY['owner','finance','auditor']::text[]),false);
 IF (NOT central OR p_organization_id IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM public.petro_organizations o WHERE o.kind IN('station','provider') AND(p_organization_id IS NULL OR o.id=p_organization_id)
 AND(central OR EXISTS(SELECT 1 FROM public.petro_memberships m WHERE m.organization_id=o.id AND m.user_id=actor AND m.active AND m.role IN('organization_owner','manager','finance')))) THEN
 RAISE EXCEPTION 'FORBIDDEN_MERCHANT_STATEMENT' USING ERRCODE='42501';END IF;
 IF p_branch_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.petro_branches b JOIN public.petro_organizations o ON o.id=b.organization_id
 WHERE b.id=p_branch_id AND o.kind IN('station','provider') AND(p_organization_id IS NULL OR o.id=p_organization_id)
 AND(central OR EXISTS(SELECT 1 FROM public.petro_memberships m WHERE m.organization_id=b.organization_id AND m.user_id=actor AND m.active AND m.role IN('organization_owner','manager','finance')
 AND(m.scope='organization' OR EXISTS(SELECT 1 FROM public.petro_membership_branches mb WHERE mb.membership_id=m.id AND mb.organization_id=b.organization_id AND mb.branch_id=b.id))))) THEN
 RAISE EXCEPTION 'FORBIDDEN_MERCHANT_STATEMENT' USING ERRCODE='42501';END IF;
 WITH allowed_orgs AS MATERIALIZED(
 SELECT o.id,o.name,o.kind FROM public.petro_organizations o WHERE o.kind IN('station','provider')
 AND(central OR EXISTS(SELECT 1 FROM public.petro_memberships m WHERE m.organization_id=o.id AND m.user_id=actor AND m.active AND m.role IN('organization_owner','manager','finance')))
 ),allowed_branches AS MATERIALIZED(
 SELECT b.id,b.organization_id,b.name,o.name AS org_name FROM public.petro_branches b JOIN allowed_orgs o ON o.id=b.organization_id
 WHERE(p_organization_id IS NULL OR o.id=p_organization_id)
 AND(central OR EXISTS(SELECT 1 FROM public.petro_memberships m WHERE m.organization_id=b.organization_id AND m.user_id=actor AND m.active AND m.role IN('organization_owner','manager','finance')
 AND(m.scope='organization' OR EXISTS(SELECT 1 FROM public.petro_membership_branches mb WHERE mb.membership_id=m.id AND mb.organization_id=b.organization_id AND mb.branch_id=b.id))))
 ),source AS MATERIALIZED(
 SELECT v.*,b.name AS branch_name,b.org_name,receipt.receipt_number,
 coalesce(r.refunded,0) AS refunded,coalesce(r.unsettled_refund,0) AS unsettled_refund,coalesce(r.debt,0) AS debt,
 coalesce(s.paid,0) AS paid,coalesce(c.claimed,0) AS claimed,petro_private.merchant_withdrawal_held(v.payment_id) AS held
 FROM petro_private.service_order_receivables v JOIN allowed_branches b ON b.id=v.merchant_branch_id AND b.organization_id=v.merchant_organization_id
 JOIN petro_private.service_order_receipts receipt ON receipt.payment_id=v.payment_id
 LEFT JOIN LATERAL(SELECT sum(a.amount_minor) AS refunded,sum(a.unsettled_amount_minor) AS unsettled_refund,sum(a.merchant_debt_minor) AS debt FROM petro_private.service_refund_allocations a WHERE a.payment_id=v.payment_id)r ON true
 LEFT JOIN LATERAL(SELECT sum(a.amount_minor) AS paid FROM petro_private.service_receivable_settlements a WHERE a.payment_id=v.payment_id)s ON true
 LEFT JOIN LATERAL(SELECT sum(q.amount_minor) AS claimed FROM petro_private.service_refund_requests q WHERE q.payment_id=v.payment_id
 AND NOT EXISTS(SELECT 1 FROM petro_private.service_refund_withdrawals w WHERE w.request_id=q.id)
 AND NOT EXISTS(SELECT 1 FROM petro_private.service_refund_decisions d WHERE d.request_id=q.id))c ON true
 WHERE(p_branch_id IS NULL OR b.id=p_branch_id)
 ),balances AS MATERIALIZED(
 SELECT *,greatest(earned_amount_minor-unsettled_refund-paid,0) AS remaining FROM source
 ),scoped AS MATERIALIZED(
 SELECT *,least(greatest(remaining-held,0),claimed) AS disputed,
 CASE WHEN eligible_at<=as_of THEN greatest(remaining-claimed-held,0) ELSE 0 END AS eligible,
 CASE WHEN eligible_at>as_of THEN greatest(remaining-claimed-held,0) ELSE 0 END AS immature
 FROM balances
 ),page_rows AS(
 SELECT * FROM scoped ORDER BY earned_at DESC,order_id DESC LIMIT 20 OFFSET ((p_page-1)*20)
 ),branch_summary AS(
 SELECT merchant_branch_id,sum(earned_amount_minor) AS earned,sum(refunded) AS refunded,sum(paid) AS paid,sum(remaining) AS remaining,
 sum(claimed) AS claimed,sum(debt) AS debt,sum(held) AS held,sum(disputed) AS disputed,sum(eligible) AS eligible,sum(immature) AS immature
 FROM scoped GROUP BY merchant_branch_id
 )
 SELECT jsonb_build_object('asOf',as_of,'currency','EGP','timezone','Africa/Cairo','page',p_page,'pageSize',20,'withdrawalsEnabled',true,'bankPayoutEnabled',false,
 'total',(SELECT count(*) FROM scoped),
 'organizations',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'kind',kind) ORDER BY name,id),'[]'::jsonb) FROM allowed_orgs),
 'branches',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',b.id,'organizationId',b.organization_id,'name',b.name,
 'earnedMinor',coalesce(s.earned,0)::text,'refundedMinor',coalesce(s.refunded,0)::text,'settledMinor',coalesce(s.paid,0)::text,
 'pendingRefundMinor',coalesce(s.claimed,0)::text,'withdrawalReservedMinor',coalesce(s.held,0)::text,'remainingMinor',coalesce(s.remaining,0)::text,'merchantDebtMinor',coalesce(s.debt,0)::text,'disputedMinor',coalesce(s.disputed,0)::text,
 'eligibleBeforeDebtMinor',coalesce(s.eligible,0)::text,'notYetEligibleMinor',coalesce(s.immature,0)::text) ORDER BY b.name,b.id),'[]'::jsonb)
 FROM allowed_branches b LEFT JOIN branch_summary s ON s.merchant_branch_id=b.id WHERE(p_branch_id IS NULL OR b.id=p_branch_id)),
 'totals',(SELECT jsonb_build_object('earnedMinor',coalesce(sum(earned_amount_minor),0)::text,'refundedMinor',coalesce(sum(refunded),0)::text,
 'unsettledRefundMinor',coalesce(sum(unsettled_refund),0)::text,'settledMinor',coalesce(sum(paid),0)::text,'remainingMinor',coalesce(sum(remaining),0)::text,
 'pendingRefundMinor',coalesce(sum(claimed),0)::text,'withdrawalReservedMinor',coalesce(sum(held),0)::text,'merchantDebtMinor',coalesce(sum(debt),0)::text,'disputedMinor',coalesce(sum(disputed),0)::text,'eligibleBeforeDebtMinor',coalesce(sum(eligible),0)::text,
 'notYetEligibleMinor',coalesce(sum(immature),0)::text) FROM scoped),
 'items',(SELECT coalesce(jsonb_agg(jsonb_build_object('orderId',order_id,'paymentId',payment_id,'organizationId',merchant_organization_id,'organizationName',org_name,
 'branchId',merchant_branch_id,'branchName',branch_name,'receiptNumber',receipt_number,'earnedAt',earned_at,'periodStart',period_start,'periodEnd',period_end,'eligibleAt',eligible_at,
 'settlementPolicyId',settlement_policy_id,'earnedMinor',earned_amount_minor::text,'refundedMinor',refunded::text,'unsettledRefundMinor',unsettled_refund::text,
 'pendingRefundMinor',claimed::text,'withdrawalReservedMinor',held::text,'settledMinor',paid::text,'remainingMinor',remaining::text,'merchantDebtMinor',debt::text,'disputedMinor',disputed::text,'eligibleBeforeDebtMinor',eligible::text,'notYetEligibleMinor',immature::text)
 ORDER BY earned_at DESC,order_id DESC),'[]'::jsonb) FROM page_rows))
 INTO result;
 RETURN result;
END $$;
COMMIT;
