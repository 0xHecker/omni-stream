from __future__ import annotations

import argparse
import re
from pathlib import Path

SEMVER_RE = re.compile(
    r"^(?P<major>0|[1-9]\d*)\.(?P<minor>0|[1-9]\d*)\.(?P<patch>0|[1-9]\d*)"
    r"(?:-(?P<prerelease>[0-9A-Za-z.-]+))?$"
)
VERSION_LINE_RE = re.compile(r'(?m)^(version\s*=\s*")([^"]+)(")\s*$')


def parse_semver(version: str) -> tuple[int, int, int, str | None]:
    match = SEMVER_RE.match(version.strip())
    if not match:
        raise ValueError(f"Invalid semver version: {version}")
    major = int(match.group("major"))
    minor = int(match.group("minor"))
    patch = int(match.group("patch"))
    prerelease = match.group("prerelease")
    return major, minor, patch, prerelease


def next_prerelease_token(current: str | None, label: str) -> str:
    if not current:
        return f"{label}.1"
    pattern = re.compile(rf"^{re.escape(label)}\.(\d+)$")
    match = pattern.match(current)
    if not match:
        return f"{label}.1"
    return f"{label}.{int(match.group(1)) + 1}"


def bump_version(current: str, bump: str, prerelease_label: str) -> str:
    major, minor, patch, prerelease = parse_semver(current)

    if bump == "major":
        return f"{major + 1}.0.0"
    if bump == "minor":
        return f"{major}.{minor + 1}.0"
    if bump == "patch":
        return f"{major}.{minor}.{patch + 1}"
    if bump == "prerelease":
        token = next_prerelease_token(prerelease, prerelease_label)
        return f"{major}.{minor}.{patch}-{token}"

    raise ValueError(f"Unsupported bump type: {bump}")


def read_version(pyproject_path: Path) -> str:
    content = pyproject_path.read_text(encoding="utf-8")
    match = VERSION_LINE_RE.search(content)
    if not match:
        raise RuntimeError("Could not locate `version = \"...\"` in pyproject.toml")
    return match.group(2)


def write_version(pyproject_path: Path, new_version: str) -> None:
    content = pyproject_path.read_text(encoding="utf-8")
    updated, count = VERSION_LINE_RE.subn(rf'\g<1>{new_version}\g<3>', content, count=1)
    if count != 1:
        raise RuntimeError("Failed to update version in pyproject.toml")
    pyproject_path.write_text(updated, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Bump SemVer version in pyproject.toml")
    parser.add_argument("--file", default="pyproject.toml", help="Path to pyproject.toml")
    parser.add_argument(
        "--bump",
        required=True,
        choices=["major", "minor", "patch", "prerelease"],
        help="SemVer bump type",
    )
    parser.add_argument(
        "--prerelease-label",
        default="rc",
        help="Prerelease label for prerelease bumps (default: rc)",
    )
    args = parser.parse_args()

    pyproject_path = Path(args.file).resolve()
    if not pyproject_path.exists():
        raise SystemExit(f"File not found: {pyproject_path}")

    current = read_version(pyproject_path)
    new_version = bump_version(current, args.bump, args.prerelease_label)
    write_version(pyproject_path, new_version)
    print(new_version)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
