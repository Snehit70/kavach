import { expect, test } from "bun:test";
import { cutChangelog, nextVersion, releaseNotes, verifyTag } from "../scripts/release";

const log = `# Changelog

## Unreleased

### Added

- the thing

## 0.1.0 - 2026-01-01

- first
`;

test("nextVersion bumps or takes an explicit version", () => {
  expect(nextVersion("0.1.9", "patch")).toBe("0.1.10");
  expect(nextVersion("0.1.9", "minor")).toBe("0.2.0");
  expect(nextVersion("0.1.9", "major")).toBe("1.0.0");
  expect(nextVersion("0.1.9", "0.3.0-rc.1")).toBe("0.3.0-rc.1");
  expect(() => nextVersion("0.1.9", "next")).toThrow();
});

test("cutChangelog moves Unreleased into a dated section", () => {
  const out = cutChangelog(log, "0.2.0", "2026-10-22");
  expect(out).toContain("## Unreleased\n\n## 0.2.0 - 2026-10-22\n\n### Added\n\n- the thing");
  expect(releaseNotes(out, "0.2.0")).toBe("### Added\n\n- the thing");
  expect(releaseNotes(out, "0.1.0")).toBe("- first");
  expect(() => cutChangelog(out, "0.2.0", "2026-10-22")).toThrow("already has");
  expect(() => cutChangelog(out, "0.3.0", "2026-10-22")).toThrow("empty");
});

test("verifyTag checks the tag against package.json and the changelog", () => {
  expect(verifyTag("v0.1.0", "0.1.0", log)).toEqual([]);
  expect(verifyTag("v0.1.1", "0.1.0", log)).toEqual([
    "tag v0.1.1 does not match package.json v0.1.0",
  ]);
  expect(verifyTag("v0.2.0", "0.2.0", log)).toEqual(["CHANGELOG.md has no 0.2.0 section"]);
});
