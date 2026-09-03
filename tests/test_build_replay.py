import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from build_replay import (  # noqa: E402
    Classifier,
    GitRecord,
    authorship_class,
    build_replay,
    parse_numstat_blob,
    parse_status_blob,
    pathspecs,
    remote_clone_args,
)


def run(repo: Path, *args: str, env: dict[str, str] | None = None) -> str:
    process = subprocess.run(
        [*args],
        cwd=repo,
        env=env,
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    )
    return process.stdout.strip()


class ParsingTests(unittest.TestCase):
    def test_numstat_parses_files_and_renames(self):
        stats = parse_numstat_blob(b"\0\n3\t2\tsrc/main.py\0\n4\t1\t\0old.py\0new.py\0")
        self.assertEqual((stats[0].added, stats[0].deleted, stats[0].path), (3, 2, "src/main.py"))
        self.assertEqual((stats[1].old_path, stats[1].path), ("old.py", "new.py"))

    def test_status_parses_files_and_renames(self):
        self.assertEqual(
            parse_status_blob(b"\0\nM\0src/main.py\0R098\0old.py\0new.py\0"),
            [("M", "src/main.py", None), ("R", "new.py", "old.py")],
        )

    def test_excludes_get_a_positive_root_pathspec(self):
        self.assertEqual(
            pathspecs([], ["vendor/**"]),
            [":(top,glob)**", ":(exclude,top,glob)vendor/**"],
        )

    def test_remote_clone_limits_blobs_and_default_branch(self):
        args = remote_clone_args(
            "https://github.com/example/project.git", Path("/tmp/project"), "HEAD"
        )
        self.assertIn("--filter=blob:limit=1m", args)
        self.assertIn("--single-branch", args)
        self.assertIn("--no-tags", args)
        self.assertNotIn("--branch", args)

    def test_remote_clone_maps_remote_tracking_branch(self):
        args = remote_clone_args(
            "https://github.com/example/project.git", Path("/tmp/project"), "origin/main"
        )
        branch_index = args.index("--branch")
        self.assertEqual(args[branch_index + 1], "main")
        self.assertIn("--single-branch", args)


class ClassificationTests(unittest.TestCase):
    def setUp(self):
        self.classifier = Classifier({})

    def test_test_fixture_generated_and_source_order(self):
        self.assertEqual(self.classifier.path("src/widget.test.ts"), "test")
        self.assertEqual(self.classifier.path("tests/fixtures/large.json"), "fixture")
        self.assertEqual(self.classifier.path("web/package-lock.json"), "generated")
        self.assertEqual(self.classifier.path("src/main.py"), "source")

    def test_unmarked_is_not_called_manual(self):
        record = GitRecord(
            sha="a" * 40,
            parents=[],
            authored_at="2026-01-01T00:00:00Z",
            committed_at="2026-01-01T00:00:00Z",
            author_name="A Person",
            author_email="person@example.com",
            committer_name="A Person",
            committer_email="person@example.com",
            subject="change",
            body="",
            stats=[],
        )
        self.assertEqual(authorship_class(self.classifier.signals(record)), "unmarked")

    def test_claude_coauthor_is_explicit_agent_signal(self):
        record = GitRecord(
            sha="a" * 40,
            parents=[],
            authored_at="2026-01-01T00:00:00Z",
            committed_at="2026-01-01T00:00:00Z",
            author_name="A Person",
            author_email="person@example.com",
            committer_name="A Person",
            committer_email="person@example.com",
            subject="change",
            body="Co-Authored-By: Claude <noreply@anthropic.com>",
            stats=[],
        )
        signals = self.classifier.signals(record)
        self.assertIn("claude-coauthor", signals)
        self.assertEqual(authorship_class(signals), "agent-assisted")


class ReplayIntegrationTests(unittest.TestCase):
    def make_repo(self, root: Path) -> Path:
        repo = root / "fixture-repo"
        repo.mkdir()
        run(repo, "git", "init", "-b", "main")
        run(repo, "git", "config", "user.name", "Example Human")
        run(repo, "git", "config", "user.email", "human@example.com")

        (repo / "src").mkdir()
        (repo / "tests").mkdir()
        (repo / "fixtures").mkdir()
        (repo / "src/main.py").write_text("one\ntwo\nthree\n", encoding="utf-8")
        (repo / "tests/test_main.py").write_text("def test_main():\n    assert True\n", encoding="utf-8")
        (repo / "fixtures/large.txt").write_text("a\nb\nc\nd\n", encoding="utf-8")
        run(repo, "git", "add", ".")
        run(repo, "git", "commit", "-m", "initial city")

        run(repo, "git", "switch", "-c", "agent-feature")
        (repo / "src/main.py").write_text("one\ntwo\nthree\nfour\nfive\n", encoding="utf-8")
        run(repo, "git", "add", "src/main.py")
        run(
            repo,
            "git",
            "-c",
            "user.name=Claude",
            "-c",
            "user.email=noreply@anthropic.com",
            "commit",
            "-m",
            "agent feature",
        )

        run(repo, "git", "switch", "main")
        (repo / "README.md").write_text("# fixture\n", encoding="utf-8")
        run(repo, "git", "add", "README.md")
        run(repo, "git", "commit", "-m", "document fixture")
        run(repo, "git", "merge", "--no-ff", "agent-feature", "-m", "merge agent feature")
        return repo

    def test_replay_matches_tree_and_aggregates_merged_agent_signal(self):
        with tempfile.TemporaryDirectory() as raw_temp:
            repo = self.make_repo(Path(raw_temp))
            replay = build_replay(
                repo,
                "HEAD",
                "fixture-repo",
                Classifier({}),
                [],
                checkpoint_every=2,
                validate=True,
            )
            self.assertEqual(replay["summary"]["commits"], 3)
            self.assertEqual(replay["summary"]["reachableCommits"], 4)
            self.assertEqual(replay["summary"]["locByCategory"]["source"], 5)
            self.assertEqual(replay["summary"]["locByCategory"]["test"], 2)
            self.assertEqual(replay["summary"]["locByCategory"]["fixture"], 4)
            self.assertEqual(replay["events"][-1]["authorship"], "agent-assisted")
            self.assertIn("agent-author", replay["events"][-1]["signals"])
            self.assertEqual(replay["definitions"]["cityCategories"], ["source", "test"])
            json.dumps(replay)

    def test_path_filter_builds_a_self_consistent_subtree_replay(self):
        with tempfile.TemporaryDirectory() as raw_temp:
            repo = self.make_repo(Path(raw_temp))
            replay = build_replay(
                repo,
                "HEAD",
                "fixture-repo/src",
                Classifier({}),
                ["src"],
                checkpoint_every=100,
                validate=True,
            )
            self.assertTrue(all(path["path"].startswith("src/") for path in replay["paths"]))
            self.assertEqual(replay["summary"]["allTextLoc"], 5)
            self.assertGreaterEqual(replay["summary"]["reachableCommits"], replay["summary"]["commits"])
            self.assertEqual(replay["events"][-1]["authorship"], "agent-assisted")


if __name__ == "__main__":
    unittest.main()
