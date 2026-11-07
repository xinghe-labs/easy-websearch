#!/usr/bin/env python3
"""easy-websearch setup — one-command onboarding.

Zero dependencies (stdlib only). Python >= 3.11.

  python3 scripts/setup.py                detect agent dirs → install → verify
  python3 scripts/setup.py --dir <path>   install into a specific skills dir
                                          (repeatable)
  python3 scripts/setup.py --list         only show detected dirs

What it does:
  1. Finds agent skill directories that exist (~/.claude/skills,
     ~/.agents/skills, project-level .claude/skills, .agents/skills).
     If none exist, defaults to ~/.claude/skills.
  2. Copies this skill folder into <dir>/easy-websearch (safe excludes:
     .git, sandbox, caches). Existing installs are updated in place.
  3. Runs the doctor health check from the installed copy and prints a
     summary.
  4. Prints what to do next (talk to your agent; optional keys).
"""
import argparse
import json
import os
import shutil
import subprocess
import sys

script_dir = os.path.dirname(os.path.abspath(__file__))
skill_root = os.path.dirname(script_dir)  # the folder to install
NAME = "easy-websearch"

EXCLUDE = {".git", "sandbox", "node_modules", "__pycache__"}


def copy_tree(src: str, dest: str) -> None:
    shutil.copytree(
        src, dest,
        ignore=shutil.ignore_patterns(*EXCLUDE),
        dirs_exist_ok=True,
    )


def same_place(a: str, b: str) -> bool:
    try:
        return os.path.realpath(a) == os.path.realpath(b)
    except OSError:
        return False


def main() -> None:
    p = argparse.ArgumentParser(description="easy-websearch one-command setup")
    p.add_argument("--dir", action="append", default=[],
                   help="install into this skills directory (repeatable)")
    p.add_argument("--list", action="store_true", help="only show detected dirs")
    args = p.parse_args()

    home = os.path.expanduser("~")
    candidates = [
        (os.path.join(home, ".claude", "skills"), "Claude Code (user)"),
        (os.path.join(home, ".agents", "skills"), "Agent Skills standard (user)"),
        (os.path.join(os.getcwd(), ".claude", "skills"), "Claude Code (project)"),
        (os.path.join(os.getcwd(), ".agents", "skills"), "Agent Skills standard (project)"),
    ]
    detected = [(d, w) for d, w in candidates if os.path.isdir(d)]

    if args.list:
        print("Detected agent skill directories:")
        for d, w in detected:
            print(f"  {d}  ({w})")
        if not detected:
            print("  (none found — setup will default to ~/.claude/skills)")
        if args.dir:
            print("Explicit --dir targets:", ", ".join(args.dir))
        return

    if args.dir:
        targets = [(os.path.abspath(d), "explicit --dir") for d in args.dir]
    elif detected:
        targets = detected
    else:
        d, w = candidates[0]
        print(f"No agent skill directories found — using {d} ({w}).")
        targets = [(d, w)]

    print(f"Installing {NAME} from {skill_root}\n")
    installed = []
    for tdir, who in targets:
        dest = os.path.join(tdir, NAME)
        if same_place(skill_root, dest):
            print(f"  – {dest}  (this IS the source copy — skipped)")
            continue
        existed = os.path.isdir(dest)
        try:
            os.makedirs(tdir, exist_ok=True)
            copy_tree(skill_root, dest)
            installed.append(dest)
            print(f"  ✓ {dest}  ({'updated' if existed else 'installed'})  [{who}]")
        except OSError as e:
            print(f"  ✗ {dest}  FAILED: {e}", file=sys.stderr)
    if not installed:
        print("\nNothing was installed (source == target, or all targets failed).",
              file=sys.stderr)
        sys.exit(1)

    print("\nVerifying with doctor...\n")
    doctor_script = os.path.join(os.path.dirname(installed[0]), NAME, "scripts", "doctor.py")
    summary_line = "doctor could not run — run it manually: python3 scripts/doctor.py"
    try:
        probe = subprocess.run(
            [sys.executable, doctor_script, "--json", "--timeout", "8"],
            capture_output=True, text=True, timeout=120,
        )
        if probe.returncode in (0, 1):
            d = json.loads(probe.stdout)
            ok = [e["engine"] for e in d["engines"] if e["status"] == "OK"]
            failed = [e["engine"] for e in d["engines"] if e["status"] == "FAIL"]
            skipped = sum(1 for e in d["engines"] if e["status"] == "SKIP")
            summary_line = (f"engines OK: {', '.join(ok) or 'none'}"
                            + (f" | FAILED: {', '.join(failed)} (other engines cover them; "
                               f"see README Troubleshooting)" if failed else "")
                            + f" | skipped (no key): {skipped}")
    except (OSError, subprocess.TimeoutExpired, ValueError) as e:
        summary_line = f"doctor did not run cleanly: {e}"
    print(f"  {summary_line}\n")

    print("Done. Now just talk to your agent — no configuration needed:\n"
          '  "帮我查一下 rust async runtime 的最新资料"\n'
          '  "search for the latest webgpu news"\n'
          '  "读一下这个网页的内容: https://..."\n\n'
          "Optional upgrades (never required): set BRAVE_API_KEY, TAVILY_API_KEY,\n"
          "SERPER_API_KEY, EXA_API_KEY, FIRECRAWL_API_KEY, BOCHA_API_KEY, METASO_API_KEY,\n"
          "LINKUP_API_KEY, or OLLAMA_API_KEY — engines join automatically.\n"
          'Troubleshooting: README "Troubleshooting" section, or python3 scripts/doctor.py')


if __name__ == "__main__":
    main()
