#!/usr/bin/env python3
"""Build a compact, browser-replayable code history from a Git repository.

The city follows a first-parent lineage so every event transforms one real tree
state into the next. Pull requests and hosting-provider APIs are intentionally
out of scope: this extractor needs only Git and Python's standard library.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import re
import shlex
import subprocess
import sys
import tempfile
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Iterator


MARKER = b"REPOCITY_COMMIT\0"
END_MARKER = b"REPOCITY_END\0"
STATUS_MARKER = b"REPOCITY_STATUS\0"
STATUS_CODE = {"A": 1, "M": 2, "D": 3, "R": 4, "C": 5, "T": 6}
CATEGORIES = ("source", "test", "docs", "config", "fixture", "generated")
COAUTHOR_RE = re.compile(r"^co-authored-by:\s*(.*?)\s*<([^>]+)>", re.I | re.M)

DEFAULT_CLASSIFICATION: dict[str, list[str]] = {
    "testPatterns": [
        r"(^|/)(tests?|__tests__)(/|$)",
        r"(^|/)test_[^/]*\.py$",
        r"_test\.py$",
        r"\.(test|spec)\.[^./]+$",
    ],
    "fixturePatterns": [r"(^|/)(fixtures?|mockdata|snapshots?|__snapshots__)(/|$)"],
    "generatedPatterns": [
        r"(^|/)(generated|dist|build|coverage|vendor)(/|$)",
        r"(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|uv\.lock)$",
        r"\.min\.(js|css)$",
        r"\.map$",
    ],
    "docPatterns": [r"\.(md|mdx|rst)$"],
    "sourcePatterns": [
        r"\.(py|pyi|ts|tsx|js|jsx|css|scss|sass|html|sh|bash|zsh|sql|tf|hcl|go|rs|c|cc|cpp|h|hpp|java|kt|rb|php|vue|svelte)$",
        r"(^|/)(dockerfile|makefile)$",
    ],
    "agentIdentityPatterns": [
        r"anthropic",
        r"openai",
        r"cursor\.com",
        r"cursoragent",
        r"^claude\b",
        r"^codex\b",
        r"^cursor agent\b",
    ],
    "automationIdentityPatterns": [
        r"dependabot",
        r"renovate",
        r"github-actions",
        r"\[bot\]",
        r"bot@",
    ],
}


@dataclass
class Numstat:
    added: int | None
    deleted: int | None
    path: str
    old_path: str | None = None


@dataclass
class GitRecord:
    sha: str
    parents: list[str]
    authored_at: str
    committed_at: str
    author_name: str
    author_email: str
    committer_name: str
    committer_email: str
    subject: str
    body: str
    stats: list[Numstat]


class Classifier:
    def __init__(self, values: dict[str, list[str]]):
        merged = {**DEFAULT_CLASSIFICATION, **values}
        self.test = self._compile(merged["testPatterns"])
        self.fixture = self._compile(merged["fixturePatterns"])
        self.generated = self._compile(merged["generatedPatterns"])
        self.docs = self._compile(merged["docPatterns"])
        self.source = self._compile(merged["sourcePatterns"])
        self.agent = self._compile(merged["agentIdentityPatterns"])
        self.automation = self._compile(merged["automationIdentityPatterns"])

    @staticmethod
    def _compile(patterns: list[str]) -> re.Pattern[str]:
        return re.compile("|".join(f"(?:{pattern})" for pattern in patterns), re.I)

    def path(self, value: str) -> str:
        lower = value.lower()
        if self.fixture.search(lower):
            return "fixture"
        if self.generated.search(lower):
            return "generated"
        if self.test.search(lower):
            return "test"
        if self.docs.search(lower):
            return "docs"
        if self.source.search(lower):
            return "source"
        return "config"

    def signals(self, record: GitRecord) -> set[str]:
        signals: set[str] = set()
        identities = " ".join(
            [record.author_name, record.author_email, record.committer_name, record.committer_email]
        )
        if self.agent.search(identities):
            signals.add("agent-author")
        if self.automation.search(identities):
            signals.add("automation-author")
        for name, email in COAUTHOR_RE.findall(record.body):
            identity = f"{name} {email}"
            if self.agent.search(identity):
                normalized = identity.lower()
                if "claude" in normalized or "anthropic" in normalized:
                    signals.add("claude-coauthor")
                elif "cursor" in normalized:
                    signals.add("cursor-coauthor")
                elif "codex" in normalized or "openai" in normalized:
                    signals.add("codex-coauthor")
                else:
                    signals.add("agent-coauthor")
            if self.automation.search(identity):
                signals.add("automation-coauthor")
        return signals


def authorship_class(signals: Iterable[str]) -> str:
    values = set(signals)
    if values & {
        "agent-author",
        "agent-coauthor",
        "claude-coauthor",
        "codex-coauthor",
        "cursor-coauthor",
    }:
        return "agent-assisted"
    if values & {"automation-author", "automation-coauthor"}:
        return "automation"
    return "unmarked"


def run(
    args: list[str],
    *,
    cwd: Path | None = None,
    allowed: set[int] | None = None,
) -> bytes:
    proc = subprocess.run(
        args,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    allowed = allowed or {0}
    if proc.returncode not in allowed:
        stderr = proc.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(f"Command failed ({proc.returncode}): {shlex.join(args)}\n{stderr}")
    return proc.stdout


def remote_clone_args(
    url: str,
    destination: Path,
    ref: str,
    clone_depth: int | None = None,
    clone_filter: str = "blob:limit=1m",
) -> list[str]:
    """Build a bandwidth-conscious clone command for a remote replay target."""
    args = [
        "git",
        "clone",
        f"--filter={clone_filter}",
        "--no-checkout",
        "--progress",
    ]
    if clone_depth is not None:
        args.extend(["--depth", str(clone_depth)])
    branch: str | None = None
    if ref == "HEAD":
        args.extend(["--single-branch", "--no-tags"])
    elif ref.startswith("origin/"):
        branch = ref.removeprefix("origin/")
    elif ref.startswith("refs/heads/"):
        branch = ref.removeprefix("refs/heads/")
    elif re.fullmatch(r"(?![0-9a-fA-F]{7,40}$)[A-Za-z0-9._/-]+", ref):
        branch = ref
    if branch:
        args.extend(["--single-branch", "--branch", branch])
    args.extend([url, str(destination)])
    return args


def clone_remote(
    url: str,
    destination: Path,
    ref: str,
    clone_depth: int | None = None,
    clone_filter: str = "blob:limit=1m",
) -> None:
    """Clone while leaving Git's progress visible for large repositories."""
    proc = subprocess.run(
        remote_clone_args(url, destination, ref, clone_depth, clone_filter),
        stdout=subprocess.DEVNULL,
        check=False,
    )
    if proc.returncode:
        raise RuntimeError(f"Git clone failed with exit code {proc.returncode}")


def decode(value: bytes) -> str:
    return value.decode("utf-8", "replace")


def parse_numstat_blob(blob: bytes) -> list[Numstat]:
    tokens = blob.lstrip(b"\0\n").split(b"\0")
    result: list[Numstat] = []
    index = 0
    while index < len(tokens):
        token = tokens[index].lstrip(b"\n")
        index += 1
        if not token or b"\t" not in token:
            continue
        parts = token.split(b"\t", 2)
        if len(parts) != 3:
            continue
        added_raw, deleted_raw, path_raw = parts
        added = int(added_raw) if added_raw.isdigit() else None
        deleted = int(deleted_raw) if deleted_raw.isdigit() else None
        if path_raw:
            result.append(Numstat(added, deleted, decode(path_raw)))
            continue
        if index + 1 >= len(tokens):
            continue
        old_path = decode(tokens[index])
        new_path = decode(tokens[index + 1])
        index += 2
        result.append(Numstat(added, deleted, new_path, old_path=old_path))
    return result


def parse_log(data: bytes) -> list[GitRecord]:
    records: list[GitRecord] = []
    for chunk in data.split(MARKER)[1:]:
        if END_MARKER not in chunk:
            continue
        metadata, stats = chunk.split(END_MARKER, 1)
        fields = metadata.split(b"\0")
        if len(fields) < 10:
            continue
        records.append(
            GitRecord(
                sha=decode(fields[0]),
                parents=decode(fields[1]).split(),
                authored_at=decode(fields[2]),
                committed_at=decode(fields[3]),
                author_name=decode(fields[4]),
                author_email=decode(fields[5]),
                committer_name=decode(fields[6]),
                committer_email=decode(fields[7]),
                subject=decode(fields[8]),
                body=decode(fields[9]),
                stats=parse_numstat_blob(stats),
            )
        )
    return records


def parse_status_blob(blob: bytes) -> list[tuple[str, str, str | None]]:
    tokens = [token.lstrip(b"\n") for token in blob.lstrip(b"\0\n").split(b"\0")]
    result: list[tuple[str, str, str | None]] = []
    index = 0
    while index < len(tokens):
        raw_status = tokens[index]
        index += 1
        if not raw_status:
            continue
        status = decode(raw_status)
        kind = status[:1]
        if kind in {"R", "C"}:
            if index + 1 >= len(tokens):
                break
            old_path, new_path = decode(tokens[index]), decode(tokens[index + 1])
            index += 2
            result.append((kind, new_path, old_path))
        else:
            if index >= len(tokens):
                break
            result.append((kind, decode(tokens[index]), None))
            index += 1
    return result


def pathspecs(includes: list[str], excludes: list[str]) -> list[str]:
    values = list(includes)
    if excludes and not values:
        values.append(":(top,glob)**")
    values.extend(f":(exclude,top,glob){pattern}" for pattern in excludes)
    return values


def git_log(repo: Path, ref: str, paths: list[str], *, first_parent: bool) -> list[GitRecord]:
    fmt = (
        "REPOCITY_COMMIT%x00%H%x00%P%x00%aI%x00%cI%x00%an%x00%ae%x00"
        "%cn%x00%ce%x00%s%x00%B%x00REPOCITY_END%x00"
    )
    args = [
        "git",
        "log",
        ref,
        "--reverse",
        "--topo-order",
        "--root",
        "--find-renames=50%",
        "--numstat",
        "-z",
        f"--format={fmt}",
    ]
    if first_parent:
        args.extend(["--first-parent", "--diff-merges=first-parent"])
    if paths:
        args.extend(["--", *paths])
    return parse_log(run(args, cwd=repo))


def git_statuses(repo: Path, ref: str, paths: list[str]) -> dict[str, dict[str, tuple[str, str | None]]]:
    fmt = "REPOCITY_STATUS%x00%H%x00REPOCITY_END%x00"
    args = [
        "git",
        "log",
        ref,
        "--reverse",
        "--topo-order",
        "--root",
        "--first-parent",
        "--diff-merges=first-parent",
        "--find-renames=50%",
        "--name-status",
        "-z",
        f"--format={fmt}",
    ]
    if paths:
        args.extend(["--", *paths])
    output = run(args, cwd=repo)
    result: dict[str, dict[str, tuple[str, str | None]]] = {}
    for chunk in output.split(STATUS_MARKER)[1:]:
        if END_MARKER not in chunk:
            continue
        sha_raw, blob = chunk.split(END_MARKER, 1)
        sha = decode(sha_raw.split(b"\0")[0])
        result[sha] = {path: (kind, old) for kind, path, old in parse_status_blob(blob)}
    return result


def current_text_lines(repo: Path, ref: str, paths: list[str]) -> dict[str, int]:
    args = ["git", "grep", "-I", "--count", "-e", "", ref]
    if paths:
        args.extend(["--", *paths])
    output = run(args, cwd=repo, allowed={0, 1})
    prefix = f"{ref}:"
    result: dict[str, int] = {}
    for line in decode(output).splitlines():
        if not line.startswith(prefix):
            continue
        path, count = line[len(prefix) :].rsplit(":", 1)
        if count.isdigit():
            result[path] = int(count)
    return result


def load_config(path: Path | None) -> dict[str, Any]:
    if path is None or not path.exists():
        return {"classification": DEFAULT_CLASSIFICATION}
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Config must contain a JSON object: {path}")
    return value


def nested_commit_sets(
    mainline: list[GitRecord], all_by_sha: dict[str, GitRecord]
) -> dict[str, set[str]]:
    """Assign newly integrated branch commits to the first mainline event that ships them."""
    shipped: set[str] = set()
    result: dict[str, set[str]] = {}
    for event in mainline:
        integrated = {event.sha}
        stack = list(event.parents[1:])
        while stack:
            sha = stack.pop()
            if sha in shipped or sha in integrated:
                continue
            integrated.add(sha)
            record = all_by_sha.get(sha)
            if record:
                stack.extend(record.parents)
        result[event.sha] = integrated
        shipped.update(integrated)
    return result


def looks_like_remote(source: str) -> bool:
    if "://" in source or source.startswith("git@"):
        return True
    return bool(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", source))


@contextlib.contextmanager
def resolve_repo(
    source: str,
    ref: str = "HEAD",
    clone_depth: int | None = None,
    clone_filter: str = "blob:limit=1m",
) -> Iterator[Path]:
    local = Path(source).expanduser()
    if local.exists():
        if clone_depth is not None:
            raise ValueError("--clone-depth is only valid for remote repositories")
        repo = local.resolve()
        run(["git", "rev-parse", "--git-dir"], cwd=repo)
        yield repo
        return
    if not looks_like_remote(source):
        raise ValueError(f"Repository does not exist: {source}")
    url = (
        f"https://github.com/{source}.git"
        if "://" not in source and not source.startswith("git@")
        else source
    )
    with tempfile.TemporaryDirectory(prefix="repocity-clone.") as raw_temp:
        destination = Path(raw_temp) / "repo"
        clone_remote(url, destination, ref, clone_depth, clone_filter)
        yield destination


def repository_name(repo: Path, requested: str | None) -> str:
    if requested:
        return requested
    remote = decode(run(["git", "remote", "get-url", "origin"], cwd=repo, allowed={0, 2})).strip()
    candidate = remote.rstrip("/").rsplit("/", 1)[-1] if remote else repo.name
    return re.sub(r"\.git$", "", candidate) or repo.name


def build_replay(
    repo: Path,
    ref: str,
    name: str,
    classifier: Classifier,
    paths: list[str],
    checkpoint_every: int,
    validate: bool,
) -> dict[str, Any]:
    tip = decode(run(["git", "rev-parse", "--verify", f"{ref}^{{commit}}"], cwd=repo)).strip()
    records = git_log(repo, tip, paths, first_parent=True)
    if not records:
        raise RuntimeError(f"No commits found for {ref} and the selected paths")
    all_records = git_log(repo, tip, paths, first_parent=False)
    all_record_shas = {record.sha for record in all_records}
    all_records.extend(record for record in records if record.sha not in all_record_shas)
    all_records.sort(key=lambda record: (record.committed_at, record.sha))
    all_by_sha = {record.sha: record for record in all_records}
    commit_ids = {record.sha: index for index, record in enumerate(all_records)}
    integrated = nested_commit_sets(records, all_by_sha)
    statuses = git_statuses(repo, tip, paths)

    people: list[dict[str, Any]] = []
    person_ids: dict[tuple[str, str], int] = {}
    raw_people: dict[tuple[str, str], int] = {}
    for record in all_records:
        raw = (record.author_name, record.author_email)
        if raw in raw_people:
            continue
        signals = classifier.signals(record)
        kind = "agent" if "agent-author" in signals else (
            "automation" if "automation-author" in signals else "unmarked"
        )
        display = record.author_name.strip() or record.author_email.split("@", 1)[0] or "Unknown"
        canonical = (display, kind)
        if canonical not in person_ids:
            person_ids[canonical] = len(people)
            people.append({"id": len(people), "name": display, "kind": kind})
        raw_people[raw] = person_ids[canonical]

    path_ids: dict[str, int] = {}
    path_meta: list[dict[str, Any]] = []
    loc: dict[int, int] = {}
    peak: dict[int, int] = defaultdict(int)
    binary_changes = 0

    def path_id(path: str) -> int:
        if path not in path_ids:
            identifier = len(path_meta)
            path_ids[path] = identifier
            path_meta.append(
                {
                    "id": identifier,
                    "path": path,
                    "category": classifier.path(path),
                    "peakLoc": 0,
                    "finalLoc": 0,
                }
            )
        return path_ids[path]

    events: list[dict[str, Any]] = []
    checkpoints: list[list[Any]] = []
    for index, record in enumerate(records):
        status_map = statuses.get(record.sha, {})
        changes: list[list[int]] = []
        category_adds: dict[str, int] = defaultdict(int)
        category_removals: dict[str, int] = defaultdict(int)
        for stat in record.stats:
            if stat.added is None or stat.deleted is None:
                binary_changes += 1
                continue
            kind, status_old = status_map.get(stat.path, ("M", stat.old_path))
            old_path = stat.old_path or status_old
            identifier = path_id(stat.path)
            old_identifier = path_id(old_path) if old_path else -1
            category = classifier.path(stat.path)
            category_adds[category] += stat.added
            category_removals[category] += stat.deleted

            if kind in {"R", "C"} and old_identifier >= 0:
                old_loc = loc.get(old_identifier, 0)
                if kind == "R":
                    loc.pop(old_identifier, None)
                next_loc = max(0, old_loc + stat.added - stat.deleted)
                if next_loc:
                    loc[identifier] = next_loc
                else:
                    loc.pop(identifier, None)
            elif kind == "D":
                loc.pop(identifier, None)
            else:
                next_loc = max(0, loc.get(identifier, 0) + stat.added - stat.deleted)
                if next_loc:
                    loc[identifier] = next_loc
                else:
                    loc.pop(identifier, None)
            if identifier in loc:
                peak[identifier] = max(peak[identifier], loc[identifier])
            changes.append(
                [identifier, stat.added, stat.deleted, STATUS_CODE.get(kind, 2), old_identifier]
            )

        constituent = integrated.get(record.sha, {record.sha})
        signals: set[str] = set()
        for sha in constituent:
            nested = all_by_sha.get(sha)
            if nested:
                signals.update(classifier.signals(nested))
        events.append(
            {
                "sha": record.sha,
                "sourceRepo": name,
                "authoredAt": record.authored_at,
                "committedAt": record.committed_at,
                "author": raw_people[(record.author_name, record.author_email)],
                "subject": record.subject,
                "parentCount": len(record.parents),
                "additions": sum(category_adds.values()),
                "removals": sum(category_removals.values()),
                "testAdditions": category_adds["test"],
                "testRemovals": category_removals["test"],
                "signals": sorted(signals),
                "authorship": authorship_class(signals),
                "commits": sorted(commit_ids[sha] for sha in constituent if sha in commit_ids),
                "changes": changes,
            }
        )
        if (index + 1) % checkpoint_every == 0 or index == len(records) - 1:
            checkpoints.append([index, [[identifier, value] for identifier, value in sorted(loc.items())]])

    loc_by_category = {category: 0 for category in CATEGORIES}
    files_by_category = {category: 0 for category in CATEGORIES}
    for identifier, value in loc.items():
        category = path_meta[identifier]["category"]
        loc_by_category[category] += value
        files_by_category[category] += 1
        path_meta[identifier]["finalLoc"] = value
    for identifier, value in peak.items():
        path_meta[identifier]["peakLoc"] = value

    expected = current_text_lines(repo, tip, paths)
    computed_total = sum(loc.values())
    expected_total = sum(expected.values())
    if validate and computed_total != expected_total:
        raise RuntimeError(
            f"Replay LOC {computed_total:,} does not match Git tree LOC {expected_total:,}. "
            "Check path filters, rename handling, or rerun with --no-validate while investigating."
        )

    mainline_ids = {record.sha: index for index, record in enumerate(records)}
    commits = []
    for record in all_records:
        signals = classifier.signals(record)
        commits.append(
            {
                "sha": record.sha,
                "authoredAt": record.authored_at,
                "committedAt": record.committed_at,
                "author": raw_people[(record.author_name, record.author_email)],
                "subject": record.subject,
                "parents": [commit_ids[parent] for parent in record.parents if parent in commit_ids],
                "mainlineEvent": mainline_ids.get(record.sha),
                "additions": sum(stat.added or 0 for stat in record.stats),
                "removals": sum(stat.deleted or 0 for stat in record.stats),
                "signals": sorted(signals),
                "authorship": authorship_class(signals),
            }
        )

    return {
        "version": 1,
        "repo": name,
        "ref": ref,
        "tip": tip,
        "start": records[0].committed_at,
        "end": records[-1].committed_at,
        "definitions": {
            "history": "First-parent commits; each event is a real tree-to-tree transition.",
            "loc": "Text lines reconstructed from Git numstat; binary changes are counted separately.",
            "removals": "Lines removed are positive quantities, not negative growth.",
            "unmarkedAuthorship": "No explicit agent or automation signal was found; this is not proof of manual authorship.",
            "cityCategories": ["source", "test"],
            "excludedFromCity": ["docs", "config", "fixture", "generated"],
        },
        "people": people,
        "paths": path_meta,
        "commits": commits,
        "events": events,
        "checkpoints": checkpoints,
        "summary": {
            "commits": len(records),
            "reachableCommits": len(all_records),
            "filesByCategory": files_by_category,
            "locByCategory": loc_by_category,
            "allTextLoc": expected_total,
            "binaryChanges": binary_changes,
        },
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build RepoCity replay JSON using only a repository's Git history."
    )
    parser.add_argument(
        "repo",
        nargs="?",
        default=".",
        help="Local repository, Git URL, or GitHub owner/name (default: current directory).",
    )
    parser.add_argument("--ref", default="HEAD", help="Commit or branch to replay (default: HEAD).")
    parser.add_argument("--name", help="Display name stored in the replay.")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("public/data/replay.json"),
        help="Replay JSON destination.",
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=Path("public/repocity.config.json"),
        help="RepoCity config containing classification patterns.",
    )
    parser.add_argument(
        "--include",
        action="append",
        default=[],
        metavar="PATHSPEC",
        help="Limit history to a path; repeat for multiple paths.",
    )
    parser.add_argument(
        "--exclude",
        action="append",
        default=[],
        metavar="GLOB",
        help="Exclude a Git glob from history; repeat for multiple globs.",
    )
    parser.add_argument("--checkpoint-every", type=int, default=100)
    parser.add_argument(
        "--clone-depth",
        type=int,
        help=(
            "For a remote repository, replay only the most recent N commits from a shallow "
            "clone. Useful for very large histories; document the resulting boundary."
        ),
    )
    parser.add_argument(
        "--clone-filter",
        choices=("blob:limit=1m", "blob:none", "tree:0"),
        default="blob:limit=1m",
        help=(
            "Partial-clone filter for remote inputs. tree:0 minimizes the initial transfer for "
            "very large repositories but lazily fetches selected history data."
        ),
    )
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON for inspection.")
    parser.add_argument("--no-validate", action="store_true", help="Skip final LOC validation.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.checkpoint_every < 1:
        raise ValueError("--checkpoint-every must be at least 1")
    if args.clone_depth is not None and args.clone_depth < 1:
        raise ValueError("--clone-depth must be at least 1")
    config = load_config(args.config)
    classifier = Classifier(config.get("classification") or {})
    selected_paths = pathspecs(args.include, args.exclude)
    with resolve_repo(args.repo, args.ref, args.clone_depth, args.clone_filter) as repo:
        name = repository_name(repo, args.name)
        replay = build_replay(
            repo,
            args.ref,
            name,
            classifier,
            selected_paths,
            args.checkpoint_every,
            not args.no_validate,
        )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(
            replay,
            indent=2 if args.pretty else None,
            separators=None if args.pretty else (",", ":"),
            ensure_ascii=False,
        ) + ("\n" if args.pretty else ""),
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "output": str(args.output),
                "repo": replay["repo"],
                "ref": replay["ref"],
                "tip": replay["tip"],
                "commits": len(replay["events"]),
                "paths": len(replay["paths"]),
                "sourceLoc": replay["summary"]["locByCategory"]["source"],
                "testLoc": replay["summary"]["locByCategory"]["test"],
                "fixtureLoc": replay["summary"]["locByCategory"]["fixture"],
                "generatedLoc": replay["summary"]["locByCategory"]["generated"],
                "binaryChanges": replay["summary"]["binaryChanges"],
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, ValueError, json.JSONDecodeError) as exc:
        print(f"repocity: {exc}", file=sys.stderr)
        raise SystemExit(1)
