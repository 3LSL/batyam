# Releasing Batyam

Batyam is released as `@3lsl/batyam`: a tarball attached to a GitHub release, not a package on the npm registry.

## Versions

A Batyam version is the Mermaid version it is built on, from `packages/mermaid/package.json`, followed by `-batyam.<n>`: `12.2.0-batyam.1`, `12.2.0-batyam.2`, and so on. Its tag is `batyam-v<version>`. Upstream Mermaid uses the `v*` and `mermaid@*` tags, so don't use those.

## Cutting a release

Tag the commit to release and push the tag:

```sh
git tag batyam-v12.2.0-batyam.1
git push origin batyam-v12.2.0-batyam.1
```

The Batyam release workflow (`.github/workflows/batyam-release.yml`) builds the packages, packs `packages/mermaid` as `@3lsl/batyam` at that version, checks the tarball and creates the GitHub release with the tarball attached. It fails if the tag does not start with the Mermaid version in `packages/mermaid/package.json`.

The source keeps the name `mermaid`, which the workspace and the build scripts refer to. Only the tarball is renamed.

## Depending on a release

```json
"dependencies": {
  "@3lsl/batyam": "https://github.com/3LSL/batyam/releases/download/batyam-v12.2.0-batyam.1/3lsl-batyam-12.2.0-batyam.1.tgz"
}
```

Import it as `@3lsl/batyam` rather than `mermaid`.

## Trying an unreleased build

1. Build and pack, with the package renamed:

   ```sh
   pnpm build
   cd packages/mermaid
   npm pkg set name=@3lsl/batyam
   pnpm pack
   ```

   Use `pnpm pack`, not `npm pack`: only pnpm replaces the `workspace:^` dependency on `@mermaid-js/parser` with a real version. The tarball, `3lsl-batyam-12.2.0.tgz`, lands next to `package.json`, and git does not ignore it.

2. Undo the name change: `npm pkg set name=mermaid`.

3. In the project that uses Batyam, install the tarball:

   ```sh
   npm install /path/to/batyam/packages/mermaid/3lsl-batyam-12.2.0.tgz
   ```

## Good to know

- `@mermaid-js/parser` comes from the npm registry: packing turns `workspace:^` into `^<its version>`. Changes made to `packages/parser` in Batyam are not part of a release.
- The upstream release workflows run only in `mermaid-js/mermaid`.

<!-- cspell:ignore batyam -->
