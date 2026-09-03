#!/usr/bin/env python3
"""Validate and deterministically gzip a RepoCity replay for static hosting."""

from __future__ import annotations

import argparse
import gzip
import json
import shutil
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Replay JSON produced by build_replay.py")
    parser.add_argument("output", type=Path, help="Destination ending in .json.gz")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.output.name.endswith(".json.gz"):
        raise ValueError("Output must end in .json.gz")
    with args.input.open("r", encoding="utf-8") as source:
        replay = json.load(source)
    missing = {"repo", "tip", "events", "paths", "checkpoints"} - replay.keys()
    if missing:
        raise ValueError(f"Not a RepoCity replay; missing: {', '.join(sorted(missing))}")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.input.open("rb") as source, args.output.open("wb") as raw_output:
        with gzip.GzipFile(
            filename="",
            fileobj=raw_output,
            mode="wb",
            compresslevel=9,
            mtime=0,
        ) as output:
            shutil.copyfileobj(source, output)
    print(
        f"Packaged {replay['repo']}: {len(replay['events']):,} events, "
        f"{args.output.stat().st_size:,} bytes -> {args.output}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
