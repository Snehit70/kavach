import { loadSnapshot } from "../src/snapshot.ts";
import { SORT_KEYS, sortPackages } from "../src/sort.ts";

const snap = await loadSnapshot();
if (!snap) throw new Error("no snapshot");
const items = snap.result.packages.map((pkg) => ({ pkg }));
for (const key of SORT_KEYS) {
  const samples: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    sortPackages(items, key, i % 2 ? "asc" : "desc");
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  console.log(`${key.padEnd(10)} first=${samples.at(-1)!.toFixed(1)}ms p50=${samples[10]!.toFixed(1)}ms (n=${items.length})`);
}
