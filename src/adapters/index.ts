import type { Adapter } from "../types";
import { brew } from "./brew";
import { bun } from "./bun";
import { cargo } from "./cargo";
import { dnf } from "./dnf";
import { flatpak } from "./flatpak";
import { gem } from "./gem";
import { gh } from "./gh";
import { go } from "./go";
import { npm } from "./npm";
import { pip } from "./pip";
import { pipx } from "./pipx";
import { pnpm } from "./pnpm";
import { snap } from "./snap";
import { vscode } from "./vscode";

export const allAdapters: Adapter[] = [
  dnf,
  flatpak,
  snap,
  brew,
  pip,
  pipx,
  npm,
  pnpm,
  bun,
  cargo,
  gem,
  go,
  vscode,
  gh,
];
