#!/usr/bin/env bash
# IRONCLAD drift check — Prism 5 app (prism-app-live).
# Fails loudly (exit 1) if any locked rule has drifted.
# Run: bash scripts/ironclad-check.sh   or: bun run ironclad
#
# NOTE: the free-code patterns below are written so this file itself does not
# contain either code value. Do not "simplify" them into the literal values.
set -u
cd "$(dirname "$0")/.." || exit 1
FAIL=0
fail() { echo "IRONCLAD FAIL: $1"; FAIL=1; }
ok()   { echo "IRONCLAD OK: $1"; }

# 1. Free codes must never appear in this repo.
#    Prism code is the digit 1 ten times; the Loremaster code is a hyphenated
#    word. Both live ONLY in the Render FREE_CODE env var.
hits=$(grep -rInE --exclude-dir=node_modules --exclude-dir=.git '1{10}' . || true)
if [ -n "$hits" ]; then
  echo "$hits"
  fail "free-code value (ten ones) found in the repo; the code lives ONLY in the Render FREE_CODE env var"
else
  ok "no Prism free-code value in repo"
fi
hits=$(grep -rInE --exclude-dir=node_modules --exclude-dir=.git 'open[-]book' . || true)
if [ -n "$hits" ]; then
  echo "$hits"
  fail "Loremaster free-code value found in this repo; it does not belong here"
else
  ok "no Loremaster free-code value in repo"
fi

# 2. Canon prices in the catalog (price + 3% total, what the buyer pays).
for pair in '"$499.00"' '"$514.00"' '"$49.00/month"' '"$50.47/month"' '"$39.00/month"' '"$40.17/month"' '"$539.00/year"' '"$555.17/year"' '"$99.00"' '"$101.97"' '"$33.00/month"' '"$33.99/month"' '"$26.00/month"' '"$26.78/month"' '"$363.00/year"' '"$373.89/year"' '"$29.00/month"' '"$29.87/month"' '"$19.00"' '"$19.57"' '"$25.00"' '"$25.75"' '"$59.00"' '"$60.77"'; do
  grep -qF "$pair" src/shared/catalog.ts || fail "canon price $pair missing from src/shared/catalog.ts"
done
if grep -qF '"$0.00"' src/shared/catalog.ts; then
  fail "a \$0.00 price in src/shared/catalog.ts; nothing is free"
else
  ok "canon prices present in catalog, no zero price"
fi

# 3. The pricing truth block the Photons are taught (src/server/personas.ts).
for phrase in 'A Launch is what gives the app a personality. With no Launch there is no one to talk to.' '15 percent off' '12 months for the price of 11' '3 percent processing fee' '$499 one time' '$99 one time' '$29 a month'; do
  grep -qF "$phrase" src/server/personas.ts || fail "missing from src/server/personas.ts: $phrase"
done
ok "launch model + pricing truth block present in personas.ts"

# 4. Stripe amount map agrees with canon (src/server/stripe.ts).
for amount in '51400' '$514.00' '$101.97'; do
  grep -qF "$amount" src/server/stripe.ts || fail "missing from src/server/stripe.ts: $amount"
done
ok "Stripe amounts agree with canon"

# 5. Prism must never be described as free in product copy.
#    (Legit uses — "300 chats free forever", "free trial", "free demo" — are
#    not matched by these patterns.)
hits=$(grep -rInE --exclude-dir=node_modules 'prism is free|free prism|is free for everyone' src client public || true)
if [ -n "$hits" ]; then
  echo "$hits"
  fail "Prism described as free; Prism is NOT free (see IRONCLAD.md)"
else
  ok "Prism never described as free"
fi

if [ "$FAIL" -ne 0 ]; then
  echo "IRONCLAD CHECK FAILED — see failures above. Do not ship until they are resolved by Neil, the owner."
  exit 1
fi
echo "IRONCLAD CHECK PASSED"
exit 0
