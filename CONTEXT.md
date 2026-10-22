# kavach

This context defines the inventory language for reviewing installed packages across multiple package managers.

## Language

**Package Manager**:
One system responsible for installing and updating a class of software.
_Avoid_: source, ecosystem

**Package Record**:
A normalized view of one installed package regardless of where it came from.
_Avoid_: row, item

**Outdated Package**:
A package whose installed version trails the latest known version.
_Avoid_: stale package, old dependency

**Adapter**:
The package-manager-specific integration that discovers versions and update commands.
_Avoid_: plugin, connector

**Scan**:
A refresh pass that inventories packages and optionally checks for newer versions.
_Avoid_: sync, crawl

**Verdict**:
The security call for one package: fix, no fix, hold, malware or ok.
_Avoid_: status (that is the outdated/up-to-date state)
