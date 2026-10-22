// Preloaded before any test file (see bunfig.toml). Modules resolve their
// cache, state and config paths at import time, so point them at a scratch
// directory here; a test file's own beforeAll runs too late to protect the
// user's real ~/.cache, ~/.local/state and ~/.config.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "kavach-test-"));
for (const v of ["XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME"]) {
  process.env[v] = join(root, v.slice(4, -5).toLowerCase());
}
