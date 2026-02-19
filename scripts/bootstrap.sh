#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

SKIP_SYNC=0
if [[ "${1:-}" == "--no-sync" ]]; then
  SKIP_SYNC=1
fi

REQUIRED_PYTHON_MAJOR=3
REQUIRED_PYTHON_MINOR=11
PINNED_UV_VERSION="0.10.4"
PYTHON_BIN=""
USE_MANAGED_PYTHON=0

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

python_is_compatible() {
  local candidate="$1"
  "${candidate}" - <<PY >/dev/null 2>&1
import sys
required = (${REQUIRED_PYTHON_MAJOR}, ${REQUIRED_PYTHON_MINOR})
current = sys.version_info[:2]
raise SystemExit(0 if current >= required else 1)
PY
}

run_uv() {
  if have_cmd uv; then
    uv "$@"
    return
  fi
  if [[ -n "${PYTHON_BIN}" ]]; then
    "${PYTHON_BIN}" -m uv "$@"
    return
  fi
  echo "uv is not available."
  exit 1
}

ensure_uv() {
  if have_cmd uv; then
    return
  fi

  if [[ -n "${PYTHON_BIN}" ]] && "${PYTHON_BIN}" -m uv --version >/dev/null 2>&1; then
    return
  fi

  if [[ -n "${PYTHON_BIN}" ]]; then
    "${PYTHON_BIN}" -m pip install --user --upgrade --break-system-packages "uv==${PINNED_UV_VERSION}" \
      || "${PYTHON_BIN}" -m pip install --user --upgrade "uv==${PINNED_UV_VERSION}" \
      || true
    export PATH="${HOME}/.local/bin:${HOME}/.cargo/bin:${PATH}"
    if have_cmd uv; then
      return
    fi
    if "${PYTHON_BIN}" -m uv --version >/dev/null 2>&1; then
      return
    fi
  fi

  echo "uv not found. Attempting system install..."
  if [[ "$(uname -s)" == "Darwin" ]] && have_cmd brew; then
    brew install uv || true
  elif [[ "$(uname -s)" == "Linux" ]]; then
    if have_cmd sudo && sudo -n true >/dev/null 2>&1; then
      if have_cmd apt-get; then
        sudo apt-get update && sudo apt-get install -y uv || true
      elif have_cmd dnf; then
        sudo dnf install -y uv || true
      elif have_cmd yum; then
        sudo yum install -y uv || true
      elif have_cmd pacman; then
        sudo pacman -Sy --noconfirm uv || true
      elif have_cmd zypper; then
        sudo zypper --non-interactive install uv || true
      fi
    fi
  fi

  export PATH="${HOME}/.local/bin:${HOME}/.cargo/bin:${PATH}"

  if have_cmd uv; then
    return
  fi
  if [[ -n "${PYTHON_BIN}" ]] && "${PYTHON_BIN}" -m uv --version >/dev/null 2>&1; then
    return
  fi

  return 1
}

ensure_python() {
  if have_cmd python3 && python_is_compatible python3; then
    PYTHON_BIN="python3"
    return
  fi
  if have_cmd python && python_is_compatible python; then
    PYTHON_BIN="python"
    return
  fi

  if ensure_uv; then
    if have_cmd uv; then
      echo "System Python not found. Installing uv-managed Python 3.11..."
      run_uv python install 3.11
      USE_MANAGED_PYTHON=1
      return
    fi
  fi

  echo "Python 3.11+ not found. Attempting system install..."
  case "$(uname -s)" in
    Darwin)
      if have_cmd brew; then
        brew install python@3.11 || brew install python
      else
        echo "Homebrew is required to auto-install Python on macOS."
        exit 1
      fi
      ;;
    Linux)
      if have_cmd apt-get; then
        sudo apt-get update
        sudo apt-get install -y python3 python3-pip python3-venv
      elif have_cmd dnf; then
        sudo dnf install -y python3 python3-pip
      elif have_cmd yum; then
        sudo yum install -y python3 python3-pip
      elif have_cmd pacman; then
        sudo pacman -Sy --noconfirm python python-pip
      elif have_cmd zypper; then
        sudo zypper --non-interactive install python3 python3-pip
      else
        echo "Unsupported Linux package manager. Install Python manually."
        exit 1
      fi
      ;;
    *)
      echo "Unsupported OS for this bootstrap script."
      exit 1
      ;;
  esac

  if have_cmd python3 && python_is_compatible python3; then
    PYTHON_BIN="python3"
  elif have_cmd python && python_is_compatible python; then
    PYTHON_BIN="python"
  else
    echo "Python installation completed but compatible python is still not in PATH."
    exit 1
  fi

  if ! ensure_uv; then
    echo "uv installation failed. Install uv manually from https://docs.astral.sh/uv/getting-started/installation/"
    exit 1
  fi

  if have_cmd uv; then
    echo "Optional: install uv-managed Python 3.11 runtime with 'uv python install 3.11'."
    return
  fi
}

sync_dependencies() {
  if [[ "${USE_MANAGED_PYTHON}" -eq 1 ]]; then
    run_uv sync --frozen --python 3.11
    return
  fi
  run_uv sync --frozen
}

ensure_python
if [[ -n "${PYTHON_BIN}" ]]; then
  "${PYTHON_BIN}" --version
else
  echo "Using uv-managed Python runtime."
fi
if ! ensure_uv; then
  echo "uv installation failed. Install uv manually from https://docs.astral.sh/uv/getting-started/installation/"
  exit 1
fi

if [[ "${SKIP_SYNC}" -eq 0 ]]; then
  sync_dependencies
fi

echo "Bootstrap complete."
if [[ "${SKIP_SYNC}" -eq 1 ]]; then
  if [[ "${USE_MANAGED_PYTHON}" -eq 1 ]]; then
    echo "Run 'uv sync --frozen --python 3.11' when you are ready."
  else
    echo "Run 'uv sync --frozen' (or '${PYTHON_BIN} -m uv sync --frozen') when you are ready."
  fi
fi
