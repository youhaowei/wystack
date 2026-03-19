declare const semverBrand: unique symbol;

export type SemVer = string & { readonly [semverBrand]: true };

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)*))?$/;

export function semver(input: string): SemVer {
  if (!SEMVER_RE.test(input)) {
    throw new TypeError(`Invalid semver: "${input}" — expected "major.minor.patch" or "major.minor.patch-prerelease" (e.g. "2.1.0", "2.1.0-rc.1")`);
  }
  return input as SemVer;
}

export function isSemVer(input: string): input is SemVer {
  return SEMVER_RE.test(input);
}

export function parseSemVer(ver: SemVer): { major: number; minor: number; patch: number; prerelease?: string } {
  const match = ver.match(SEMVER_RE)!;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] ? { prerelease: match[4] } : {}),
  };
}
