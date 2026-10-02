"""Windows fault-injection launchers; the replacement runs the real backend."""
from __future__ import annotations

import io
import json
from pathlib import Path
import sys
import zipfile

import pip._vendor.distlib


def main() -> None:
    root, repository, audit, exhausted = map(Path, sys.argv[1:5])
    bin_dir = root / ".hermes" / "bin"
    bin_dir.mkdir(parents=True)
    (root / "hermes_cli").mkdir()
    (root / "hermes_cli" / "main.py").write_text("# Isolated launcher fixture\n", encoding="utf-8")
    common = (
        "import json, os, sys\n"
        f"audit = {str(audit)!r}\n"
        "profile = sys.argv[sys.argv.index('--profile') + 1] if '--profile' in sys.argv else 'default'\n"
    )
    failing = common + (
        "if '--version' in sys.argv:\n"
        f"    print('Install directory: ' + {str(root)!r}); sys.exit(0)\n"
        "if '--help' in sys.argv: sys.exit(0)\n"
        "with open(audit, 'a', encoding='utf-8') as f:\n"
        "    f.write(json.dumps({'launcher': 'failed', 'pid': os.getpid(), 'profile': profile}) + '\\n')\n"
        "print('Access denied', file=sys.stderr, flush=True)\n"
        "sys.exit(5)\n"
    )
    # distlib's real Windows PE launcher keeps its Python worker attached.
    pe = (Path(pip._vendor.distlib.__file__).parent / "t64.exe").read_bytes()
    payload = io.BytesIO()
    with zipfile.ZipFile(payload, "w") as archive:
        archive.writestr("__main__.py", failing)
    (bin_dir / "hermes.exe").write_bytes(pe + f"#!{sys.executable}\n".encode() + payload.getvalue())
    good = common + (
        "with open(audit, 'a', encoding='utf-8') as f:\n"
        "    f.write(json.dumps({'launcher': 'replacement', 'pid': os.getpid(), 'profile': profile}) + '\\n')\n"
        f"if os.path.exists({str(exhausted)!r}):\n"
        "    print('Access denied: replacement', file=sys.stderr, flush=True); sys.exit(5)\n"
        f"sys.path.insert(0, {str(repository)!r})\n"
        "from hermes_cli.main import main\n"
        "sys.exit(main())\n"
    )
    good_script = root / "recovery_good.py"
    good_script.write_text(good, encoding="utf-8")
    (bin_dir / "hermes.cmd").write_text(
        "@echo off\n"
        f'if "%~1"=="--version" (echo Install directory: {root}& exit /b 0)\n'
        'if "%~1"=="serve" if "%~2"=="--help" exit /b 0\n'
        f'"{sys.executable}" -I "{good_script}" %*\n', encoding="utf-8")


if __name__ == "__main__":
    main()
