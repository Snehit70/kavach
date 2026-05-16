import type { Adapter } from "../types";
import { brew } from "./brew";
import { cargo } from "./cargo";
import { dnf } from "./dnf";
import { flatpak } from "./flatpak";
import { gem } from "./gem";
import { go } from "./go";
import { npm } from "./npm";
import { pip } from "./pip";
import { snap } from "./snap";

export const allAdapters: Adapter[] = [dnf, flatpak, snap, brew, pip, npm, cargo, gem, go];
