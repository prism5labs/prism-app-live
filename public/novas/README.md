# Nova portraits

Drop a real portrait WebP here, one per Nova, named exactly:

- `Mabel.webp`, `Hazel.webp`, `Willa.webp`, `Ruby.webp`, `Vera.webp`,
  `Sadie.webp`, `Bea.webp`, `Flora.webp`, `Pierce.webp`, `Iris.webp`,
  `Clive.webp`, `Nora.webp`

Square, 800x800. The app uses the WebP when it exists and falls
back to a generated placeholder tile (initial + triangle) when it does not.
(Until Nov 23, 2026 these were 1600px PNGs of ~3.5 MB each; the
lightweight pass replaced them with 800px WebPs of ~120 KB. The
originals live in the Labs art archive.)

All twelve are in place (Nov 19, 2026): 1950s pulp-poster portraits in
the same family as the Supernova portraits — faceted deep-teal armor with
chrome trim and red piping, young faces with fifties hair, each keeping
its role's costume, emblem, and prop, with gold rank bars and serial
N-01..N-12 — Mabel (letters and red pencil), Hazel (pocket diary),
Willa (morning paper and mug), Ruby (telephone handset), Vera (lantern),
Sadie (hourglass), Bea (journal and lamp), Flora (apron and house key),
Pierce (ledger book), Iris (card catalog box), Clive (clipboard), Nora
(compass). Known inconsistency (Nov 19, 2026): the corps line varies —
Hazel reads "SPACE POSTAL CORPS", Mabel reads "SPACE MAIL CORPS" —
slated for a later polish pass. If a portrait is ever replaced, drop
the new file here with the same name and redeploy; the service-worker
cache version must be bumped too, or existing installs will keep
serving the cached portrait.

Rename note (Nov 27, 2026): the lantern Nova is Vera — she was Jude
until Nov 27, 2026 (and June before Nov 22, 2026). The portrait file
is unchanged; only its name (here, in thumbs/, and in heroes/)
changed, at Neil's order, with her pronouns set to she/her.
