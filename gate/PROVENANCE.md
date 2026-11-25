# Vendor provenance — mmf-255 conformance gate

`vendor/` is vendored from **agentbadge** (private repo), branch `mmf-255`,
commit **`40eb49c1037fb974c2a61dc49153be8278b0020f`**.

- `vendor-shasum.txt` — sha256 of every file **as it exists upstream**,
  generated at vendor time. Verification: `sha256sum -c vendor-shasum.txt`
  from the repo root.
- Expected result after arc R1: **67/68 byte-identical + 1 disclosed delta**
  (see below).

## Disclosed delta (arc-audit R1, finding H2)

`vendor/src/server/lib/agent-wallet/ledger.ts` intentionally differs from
upstream. The 2026-11-25 arc-audit reproduced a real bug **in upstream
production code**: `readJson` returned an empty ledger on any parse error
(silent budget reset after a torn write) and `writeJson` used non-atomic
truncate-then-write (a kill/OOM mid-write tears the file). Reproduced: $18
debited against a $10 cap after truncating the ledger by 7 bytes.

Fix applied locally (documented in-file under `DISCLOSED-DELTA`):
1. `writeJson` — atomic tmp+rename; readers never see a torn file.
2. `readJson` — corrupt/present-but-invalid state throws (fail-closed:
   no ledger, no spend) instead of silently resetting the budget.

This file is an **upstream fix candidate** for agentbadge mmf-255; once the
fix lands upstream and is re-vendored, verification returns to 68/68.
