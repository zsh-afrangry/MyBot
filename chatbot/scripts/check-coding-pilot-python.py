"""Independent host check for the synthetic pilot's in-place Python quicksort.

Run with python3 -B and CODING_WORKTREE. Exit 77 means no quicksort artifact was
present; deletion of a tracked artifact, symlinks and incorrect behavior fail.
This imports task code: run it through the host's write fence. The checker itself
does not invoke a model, QQ or services; imported code can have task-side effects.
"""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys


def main():
    root = Path(os.environ["CODING_WORKTREE"]).resolve(strict=True)
    source = root / "quicksort_first_pivot.py"
    if not source.exists() and not source.is_symlink():
        tracked = subprocess.run(
            ["/usr/bin/git", "ls-files", "--error-unmatch", "--", source.name],
            cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
        )
        if tracked.returncode == 0:
            raise AssertionError("tracked Python quicksort artifact was deleted")
        print("Python quicksort check not applicable: artifact absent")
        return 77
    if source.is_symlink() or not source.is_file() or source.resolve() != source:
        raise AssertionError("Python quicksort artifact must be a regular task-local file")
    spec = importlib.util.spec_from_file_location("kurumi_pilot_quicksort", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not callable(getattr(module, "quicksort", None)):
        raise AssertionError("quicksort(values) is required")
    cases = [
        [10, 7, 8, 9, 1, 5], [], [42], [4, 2, 4, 1, 2, 4],
        [5, 4, 3, 2, 1], [-3, 0, -1, 2, -3], [2, 2, 2, 2],
    ]
    for original in cases:
        values = original.copy()
        result = module.quicksort(values)
        if values != sorted(original) or (result is not None and result is not values):
            raise AssertionError("independent Python in-place sorting assertion failed")
    print(f"{len(cases)} independent Python quicksort cases passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
