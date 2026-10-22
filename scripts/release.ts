/**
 * Release helper.
 *
 *   bun scripts/release.ts patch|minor|major|X.Y.Z   bump package.json, cut the changelog
 *   bun scripts/release.ts verify vX.Y.Z             tag matches package.json and changelog (CI)
 *   bun scripts/release.ts notes X.Y.Z               print that version's changelog section (CI)
 */

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

export type Bump = "patch" | "minor" | "major";

/** The version after `bump`, or `bump` itself when it is an explicit version. */
export function nextVersion(current: string, bump: Bump | string): string {
  const m = SEMVER.exec(current);
  if (!m) throw new Error(`current version ${current} is not semver`);
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (bump === "major") return `${maj + 1}.0.0`;
  if (bump === "minor") return `${maj}.${min + 1}.0`;
  if (bump === "patch") return `${maj}.${min}.${pat + 1}`;
  if (!SEMVER.test(bump)) throw new Error(`${bump} is not patch, minor, major or a version`);
  return bump;
}

const heading = (line: string) => /^## /.test(line);

/** Body of the `## <title>` section (title matched up to the first space or dash). */
function section(changelog: string, title: string): string | undefined {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => heading(l) && l.slice(3).split(" ")[0] === title);
  if (start < 0) return undefined;
  const end = lines.findIndex((l, i) => i > start && heading(l));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
}

/**
 * Move everything under `## Unreleased` into a new `## <version> - <date>`
 * section, leaving an empty Unreleased heading for the next round.
 */
export function cutChangelog(changelog: string, version: string, date: string): string {
  if (section(changelog, version) !== undefined)
    throw new Error(`CHANGELOG.md already has a ${version} section`);
  const body = section(changelog, "Unreleased");
  if (body === undefined) throw new Error("CHANGELOG.md has no ## Unreleased section");
  if (!body) throw new Error("## Unreleased is empty; nothing to release");
  return changelog.replace(/^## Unreleased[^\n]*\n/m, `## Unreleased\n\n## ${version} - ${date}\n`);
}

/** Changelog section for `version`, used as the GitHub release body. */
export function releaseNotes(changelog: string, version: string): string {
  const body = section(changelog, version);
  if (!body) throw new Error(`CHANGELOG.md has no ${version} section`);
  return body;
}

/** Problems that should stop a tagged release, or an empty list. */
export function verifyTag(tag: string, version: string, changelog: string): string[] {
  const problems: string[] = [];
  if (tag !== `v${version}`) problems.push(`tag ${tag} does not match package.json v${version}`);
  if (!section(changelog, version)) problems.push(`CHANGELOG.md has no ${version} section`);
  return problems;
}

async function main(args: string[]) {
  const root = new URL("..", import.meta.url).pathname;
  const pkgFile = Bun.file(`${root}package.json`);
  const logFile = Bun.file(`${root}CHANGELOG.md`);
  const pkg = (await pkgFile.json()) as { version: string };
  const changelog = await logFile.text();
  const [cmd, arg] = args;

  if (cmd === "verify") {
    const problems = verifyTag(arg ?? "", pkg.version, changelog);
    for (const p of problems) console.error(`release: ${p}`);
    process.exit(problems.length ? 1 : 0);
  }
  if (cmd === "notes") {
    process.stdout.write(`${releaseNotes(changelog, arg ?? pkg.version)}\n`);
    return;
  }
  if (!cmd) {
    console.error("usage: bun scripts/release.ts patch|minor|major|X.Y.Z | verify TAG | notes VER");
    process.exit(2);
  }

  const version = nextVersion(pkg.version, cmd);
  const date = new Date().toISOString().slice(0, 10);
  const cut = cutChangelog(changelog, version, date);
  const text = await pkgFile.text();
  await Bun.write(pkgFile, text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));
  await Bun.write(logFile, cut);
  console.log(`kavach ${pkg.version} → ${version}\n`);
  console.log("Review the diff, then:");
  console.log(`  git commit -am "release: v${version}"`);
  console.log(`  git tag -a v${version} -m v${version}`);
  console.log("  git push --follow-tags");
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`release: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
