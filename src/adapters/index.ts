import type { Adapter } from "../types";
import { dnf } from "./dnf";
import { flatpak } from "./flatpak";
import { snap } from "./snap";
import { brew } from "./brew";
import { pip } from "./pip";
import { npm } from "./npm";
import { cargo } from "./cargo";
import { gem } from "./gem";
import { go } from "./go";

export const allAdapters: Adapter[] = [dnf, flatpak, snap, brew, pip, npm, cargo, gem, go];
