-- A payout the rail cannot fund is stopped, not attempted.
--
-- `assert_payout_funded` asks our ledger whether the deal's clearing pool
-- still covers what is leaving. It is right and it is not the whole question:
-- Flutterwave keeps a **Collection** wallet and a **Payout** wallet per
-- currency, and only the second can pay a transfer. Money crosses between them
-- when Flutterwave settles — an account-level preference on their own T+1/T+5
-- cycle — and no API of theirs moves it: `/settlements` is a GET pair with no
-- endpoint to initiate one.
--
-- So a tenant whose earnings settle to their bank account, or who collects on
-- Stripe and pays out on Flutterwave where no settlement produces the payout
-- currency at all, has a ledger reading "available" beside a Payout wallet that
-- cannot pay. `_shared/dispatch.ts` asks the rail before it asks it to send,
-- and this is where that answer is recorded.
--
-- **`blocked`, deliberately, and not `failed`.** §13's ladder lives in
-- `payouts.next_attempt_at` and `fail_payout` spends it — five refusals and the
-- payout is blocked with its clock cleared, which then needs a person. Nothing
-- here was refused by anybody: we declined to ask, on a condition that comes
-- good on its own the moment a settlement lands. That is exactly §5.1's
-- no-route `blocked` — it keeps its clock and is re-asked every pass — and it
-- is why this function leaves `next_attempt_at` alone and `attempts` untouched.
-- `route_payout` already flips a `blocked` payout back to `scheduled` the next
-- time it routes, so the way out needs no new writer.
--
-- Invariant 11 holds: this stops a payout and does nothing else. No ledger
-- entry, no transfer, no change to the deal, and no person named — arithmetic
-- over a figure the rail reported is what lets it act at all, and `review_held_by`
-- stays null because nobody decided this.
--
-- **The audit row is written on entry and on a change of sentence, never per
-- pass.** `blocked` is in `DISPATCHABLE`, so a payout waiting on a settlement
-- is re-screened every pass; an unconditional insert would write one row an
-- hour for as long as a tenant took to flip a dashboard setting, and §24.3's
-- labels cannot be thinned out afterwards. The same de-duplication
-- `screen_payout` applies to its `not_eligible` signal, for the same reason.

create or replace function hold_payout_unfunded(
  p_payout_id uuid,
  p_reason    text
) returns payouts
language plpgsql
security definer
set search_path = public
as $$
declare
  p       payouts;
  v_first boolean;
begin
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'invalid_request: a rail funding hold must say what the rail reported'
      using errcode = 'check_violation';
  end if;

  select * into p from payouts where id = p_payout_id for update;

  if not found then
    raise exception 'not_found: payout % does not exist', p_payout_id
      using errcode = 'no_data_found';
  end if;

  -- Money already with the rail is not ours to stop. Recalling an in-flight
  -- transfer is a conversation with the provider, and a hold that pretended
  -- otherwise would be a lie an operator acts on — `hold_payout` refuses the
  -- same two statuses for the same reason.
  if p.status in ('paid', 'processing') then
    raise exception 'invalid_state: payout % is already % and cannot be held for funding',
      p_payout_id, p.status
      using errcode = 'check_violation';
  end if;

  v_first := p.status <> 'blocked' or coalesce(p.failure_reason, '') <> p_reason;

  update payouts
     set status         = 'blocked',
         failure_reason = p_reason
   where id = p.id
  returning * into p;

  if v_first then
    perform write_audit(p.tenant_id, p.deal_id, 'system', 'payout.blocked',
      jsonb_build_object(
        'payout_id', p.id,
        'reason_code', 'rail_balance_short',
        'reason', p_reason
      ));
  end if;

  return p;
end;
$$;

revoke all on function hold_payout_unfunded(uuid, text) from public, anon, authenticated;
revoke all on function hold_payout_unfunded(uuid, text) from payhold_ai;
grant execute on function hold_payout_unfunded(uuid, text) to service_role;
