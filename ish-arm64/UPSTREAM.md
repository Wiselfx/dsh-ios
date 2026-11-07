# Upstream

This directory is a vendored copy of https://github.com/OpenMinis/ish-arm64
(branch `master`, commit `c5c264da19148512167aa493d7bd4e50aae1b74e`, 2026-10-15,
"Merge pull request #48 from OpenMinis/feat/aot-family-match"), itself a fork of
https://github.com/ish-app/ish. It includes the changes DSH needs on top of the
upstream snapshot (see `../dsh-ios/README.md`, "Changes made to the emulator").
Local fixes on top of upstream master: `sys_truncate64` passes `AT_PWD` (not
`NULL`) to `generic_setattrat`, because upstream's `path_normalize` asserts
`at != NULL` — `truncate()` aborted the host emulator otherwise.
The previous snapshot (`7e100366a4b59557a4a0c4657d0d6115e99d1f5e`, 2026-08-13)
carried the FCVT/FCVTXN gadgets, the FMOV imm8 fix and the waitpid EINTR fix as
local patches; those landed in upstream as #22 and #29 and the local copies were
dropped in the 2026-11-07 sync. `deps/libarchive` and `deps/libapps` were git
submodules upstream and are vendored here as plain directories
(`fc6563f5130d8a7ee1fc27c0e55baef35119f26c` and `b8cacae35e5b11d64bb736a053921c16ca7faf9e`,
matching the upstream gitlinks at that commit). `deps/linux` is declared with
`update = none` upstream and is not vendored.
