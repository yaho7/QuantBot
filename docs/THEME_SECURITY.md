# Theme security

QuantBot validates ZIPs before moving an extracted revision into place. It bounds the compressed archive at 12 MiB, the uncompressed total at 32 MiB, each asset at 8 MiB and the entry count at 256. It rejects traversal, absolute and conflicting paths, links and special files, unsupported media types and incompatible versions. Declarative themes expose validated tokens and layout properties. They cannot package HTML, JavaScript or CSS.

Published assets are resolved from an immutable revision in the theme database and served from a confined directory. The control database only references a revision after its files are synced. A failed upgrade leaves the prior revision valid. QuantBot retains the previous revision for rollback. A missing or incompatible active entry returns Classic.

Frontend theme HTML is served with a CSP sandbox allowing scripts in an opaque origin and no privileged browser permissions. Scripts can load only from that revision. Network connections, nested frames, objects and forms are disabled. QuantBot embeds the theme in a sandboxed iframe and retains management, authentication and command workflows in the host. Theme authors should treat display data as ephemeral and use the versioned Host Bridge supplied by the workbench.
