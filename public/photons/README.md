# Photon portraits

Drop a real portrait PNG here, one per Photon, named exactly:

- `Prism.png`, `Juniper.png`, `Encore.png`, `Zero.png`, `Proof.png`,
  `Barnstormer.png`, `Blueprint.png`, `Calendra.png`, `Shopbell.png`,
  `Keystone.png`, `Vesper.png`, `Goldstar.png`

Square, at least 256x256. The app uses the PNG when it exists and falls
back to a generated placeholder tile (initial + triangle) when it does not.

All twelve are in place (Nov 19, 2026): 1950s retro-futuristic armor
portraits — faceted deep-teal armor with chrome trim and red piping,
young faces with fifties hair, each keeping its role's costume, emblem,
and prop — Prism (Prism 5 herself — the approved Jeeves avatar face:
fair freckled skin, blue eyes, red lipstick, dark blue fifties pompadour;
gold triangle emblem, light beam; the original, with no rank bars or
serial), Juniper (juniper emblem, wooden box), Encore (mandolin), Zero
(gold "O", letters), Proof (magnifying glass, checkmark), Blueprint
(braided ponytail, blueprints and tool belt), Calendra (calendar),
Shopbell (bell and apron, parcel), Keystone (key emblem), Vesper
(crescent moon and stars), Goldstar (gold star and prize ribbon),
Barnstormer (aviator). The large 160px hero portrait at the top of
Photon chat threads uses these same files. The new portraits are
1600x1600 PNGs. If a portrait is ever replaced, drop the new file here
with the same name and redeploy; the service-worker cache version must
be bumped too, or existing installs will keep serving the cached portrait.
