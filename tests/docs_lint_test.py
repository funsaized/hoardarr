"""Check scope, Git change selection, and the installed Vale profile."""

import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("docs_lint", ROOT / "tools/docs_lint.py")
lint = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lint)


class FileSelectionTest(unittest.TestCase):
    def test_git_changes_and_scope(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def git(*args):
                subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)

            def write(name, text="Original\n"):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text)

            git("init", "-q")
            git("config", "user.email", "test@example.invalid")
            git("config", "user.name", "Test")
            for name in ("README.md", "docs/staged.md", "docs/deleted.md", "docs/old.md"):
                write(name)
            write(".gitignore", "docs/ignored.md\n")
            git("add", ".")
            git("commit", "-qm", "Initial")
            git("tag", "base")
            write("docs/committed.md")
            git("add", ".")
            git("commit", "-qm", "Branch change")
            write("docs/staged.md", "Staged\n")
            git("add", "docs/staged.md")
            write("README.md", "Unstaged\n")
            git("mv", "docs/old.md", "docs/renamed file.md")
            (root / "docs/deleted.md").unlink()
            for name in ("examples/new guide.md", "AGENTS.md", "docs/AGENTS.md", "docs/SKILL.md",
                         "docs/evidence/capture.md", "examples/fixtures/sample.md",
                         "tests/fixture.md", "docs/ignored.md", "examples/provider/example.ts"):
                write(name)
            with patch.object(lint, "ROOT", root):
                expected = ["README.md", "docs/renamed file.md", "docs/staged.md", "examples/new guide.md"]
                self.assertEqual(lint.select_files("changed"), expected)
                self.assertEqual(lint.select_files("changed", "base"), sorted(expected + ["docs/committed.md"]))
                self.assertEqual(lint.select_files("all"), sorted(expected + ["docs/committed.md"]))


@unittest.skipUnless(lint.BINARY.is_file(), "Run docs:setup for Vale integration checks")
class ValeProfileTest(unittest.TestCase):
    def scan(self, text, path="docs/test.md", config=None):
        return subprocess.run(
            [str(lint.BINARY), "--no-global", f"--config={config or ROOT / '.vale.ini'}",
             "--output=JSON", f"--path={path}"],
            cwd=ROOT, input=text, capture_output=True, text=True,
        )

    def test_rules_are_active_and_advisory(self):
        result = self.scan(
            "# Example\n\nHoardArr uses a swamp model.\n\n"
            "The the documantation is ready.\n\n"
            "In today's rapidly evolving world, in order to be a beacon of hope, we work.\n\n"
            "The key takeaway is simple. Experts argue it is useful.\n\n"
            "It's not just a tool; it's a revolution.\n"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        alerts = [a for values in json.loads(result.stdout).values() for a in values]
        checks = {a["Check"] for a in alerts}
        self.assertTrue({"Hoardarr.Names", "Hoardarr.Terminology", "Vale.Spelling",
                         "Vale.Repetition"}.issubset(checks), checks)
        for rule in ("FillerPhrases", "PromotionalPuffery", "OpeningCliches",
                     "StructureAnnouncements", "ContrastiveFormulas", "VagueAttributions"):
            self.assertIn(f"ai-tells.{rule}", checks)
        self.assertTrue(all(a["Severity"] != "error" for a in alerts))
        self.assertTrue(all(a["Severity"] == "suggestion" for a in alerts
                            if a["Check"].startswith("ai-tells.")))

    def test_code_and_vocabulary(self):
        result = self.scan(
            "# Hoardarr\n\nHoardarr uses Torlink, Gluetun and DevVM.\n\n"
            "Downloader descriptors are rebuildable.\n\n"
            "`HoardArr documantation in order to`\n\n"
            "```text\nHoardArr documantation in order to\n```\n"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any(json.loads(result.stdout).values()), result.stdout)

    def test_vale_scope_agrees_with_runner(self):
        for path in ("README.md", "CONTRIBUTING.md", "SECURITY.md", "docs/test.md",
                     "docs/how-to/test.md", "examples/nested/test.md", "AGENTS.md",
                     "docs/AGENTS.md", "docs/SKILL.md", "docs/generated/test.md",
                     "docs/archive/test.md", "docs/evidence/nested/test.md",
                     "docs/benchmarks/test.md", "docs/qualification/results/test.md",
                     "examples/fixtures/test.md", "examples/outputs/test.md",
                     "tests/test.md", "licenses/test.md", ".agents/test.md",
                     "deploy/devvm/qualification/results/test.md", "THIRD_PARTY_NOTICES.md",
                     "docs/test.txt", "docs/example.go", "examples/provider/example.ts"):
            with self.subTest(path=path):
                result = self.scan("HoardArr documantation.\n", path)
                self.assertEqual(result.returncode, 0, result.stderr)
                has_alerts = any(json.loads(result.stdout).values())
                self.assertEqual(has_alerts, lint.in_scope(path), result.stdout)

    def test_invalid_configuration_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "invalid.ini"
            config.write_text("[*.md]\nBasedOnStyles = MissingStyle\n")
            result = self.scan("Example.\n", config=config)
            self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
