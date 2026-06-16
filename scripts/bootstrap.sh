#!/usr/bin/env bash
set -euo pipefail

REQUIRED_PYTHON_MAJOR=3
REQUIRED_PYTHON_MINOR=11
PINNED_UV_VERSION="0.10.4"
DEFAULT_REPO_URL="https://github.com/0xHecker/omni-stream.git"
DEFAULT_BRANCH="master"
DEFAULT_INSTALL_DIR="${HOME}/.local/share/omni-stream"
DEFAULT_BIN_DIR="${HOME}/.local/bin"
DEFAULT_UV_PYTHON="3.11"

SKIP_SYNC=0
RUN_AFTER_INSTALL=1
INSTALL_DIR="${OMNI_STREAM_INSTALL_DIR:-${DEFAULT_INSTALL_DIR}}"
BIN_DIR="${OMNI_STREAM_BIN_DIR:-${DEFAULT_BIN_DIR}}"
REPO_URL="${OMNI_STREAM_REPO_URL:-${DEFAULT_REPO_URL}}"
BRANCH="${OMNI_STREAM_BRANCH:-${DEFAULT_BRANCH}}"
WEB_PORT_OVERRIDE="${WEB_PORT:-}"
COORDINATOR_PORT_OVERRIDE="${COORDINATOR_PORT:-}"
AGENT_PORT_OVERRIDE="${AGENT_PORT:-}"
PYTHON_BIN=""
USE_MANAGED_PYTHON=0
UV_PYTHON_VERSION="${OMNI_STREAM_PYTHON:-${DEFAULT_UV_PYTHON}}"

usage() {
  cat <<EOF
Usage: bootstrap.sh [options]

Options:
  --install-dir PATH       Install directory (default: ${DEFAULT_INSTALL_DIR})
  --bin-dir PATH           Launcher directory (default: ${DEFAULT_BIN_DIR})
  --repo-url URL           Git repository URL (default: ${DEFAULT_REPO_URL})
  --branch NAME            Branch/tag to install (default: ${DEFAULT_BRANCH})
  --web-port PORT          Web UI port written to .env (default: 5000)
  --coordinator-port PORT  Coordinator port written to .env (default: 7000)
  --agent-port PORT        Agent port written to .env (default: 7001)
  --no-run                 Install only; do not start the app
  --no-sync                Skip dependency sync
  -h, --help               Show this help

Examples:
  curl -fsSL https://raw.githubusercontent.com/0xHecker/omni-stream/master/scripts/bootstrap.sh | bash
  curl -fsSL https://raw.githubusercontent.com/0xHecker/omni-stream/master/scripts/bootstrap.sh | bash -s -- --web-port 5050
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-dir)
      INSTALL_DIR="${2:?Missing value for --install-dir}"
      shift 2
      ;;
    --bin-dir)
      BIN_DIR="${2:?Missing value for --bin-dir}"
      shift 2
      ;;
    --repo-url)
      REPO_URL="${2:?Missing value for --repo-url}"
      shift 2
      ;;
    --branch)
      BRANCH="${2:?Missing value for --branch}"
      shift 2
      ;;
    --web-port)
      WEB_PORT_OVERRIDE="${2:?Missing value for --web-port}"
      shift 2
      ;;
    --coordinator-port)
      COORDINATOR_PORT_OVERRIDE="${2:?Missing value for --coordinator-port}"
      shift 2
      ;;
    --agent-port)
      AGENT_PORT_OVERRIDE="${2:?Missing value for --agent-port}"
      shift 2
      ;;
    --no-run)
      RUN_AFTER_INSTALL=0
      shift
      ;;
    --no-sync)
      SKIP_SYNC=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

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
  echo "uv is not available." >&2
  exit 1
}

ensure_uv() {
  if have_cmd uv; then
    return 0
  fi

  if [[ -n "${PYTHON_BIN}" ]] && "${PYTHON_BIN}" -m uv --version >/dev/null 2>&1; then
    return 0
  fi

  if [[ -n "${PYTHON_BIN}" ]]; then
    "${PYTHON_BIN}" -m pip install --user --upgrade --break-system-packages "uv==${PINNED_UV_VERSION}" \
      || "${PYTHON_BIN}" -m pip install --user --upgrade "uv==${PINNED_UV_VERSION}" \
      || true
    export PATH="${HOME}/.local/bin:${HOME}/.cargo/bin:${PATH}"
    if have_cmd uv; then
      return 0
    fi
    if "${PYTHON_BIN}" -m uv --version >/dev/null 2>&1; then
      return 0
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
    return 0
  fi
  if [[ -n "${PYTHON_BIN}" ]] && "${PYTHON_BIN}" -m uv --version >/dev/null 2>&1; then
    return 0
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

  if ensure_uv && have_cmd uv; then
    echo "System Python not found. Installing uv-managed Python 3.11..."
    run_uv python install 3.11
    USE_MANAGED_PYTHON=1
    return
  fi

  echo "Python 3.11+ not found. Attempting system install..."
  case "$(uname -s)" in
    Darwin)
      if have_cmd brew; then
        brew install python@3.11 || brew install python
      else
        echo "Homebrew is required to auto-install Python on macOS." >&2
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
        echo "Unsupported Linux package manager. Install Python manually." >&2
        exit 1
      fi
      ;;
    *)
      echo "Unsupported OS for this bootstrap script." >&2
      exit 1
      ;;
  esac

  if have_cmd python3 && python_is_compatible python3; then
    PYTHON_BIN="python3"
  elif have_cmd python && python_is_compatible python; then
    PYTHON_BIN="python"
  else
    echo "Python installation completed but compatible python is still not in PATH." >&2
    exit 1
  fi

  if ! ensure_uv; then
    echo "uv installation failed. Install uv manually from https://docs.astral.sh/uv/getting-started/installation/" >&2
    exit 1
  fi
}

sync_dependencies() {
  if [[ "${SKIP_SYNC}" -eq 1 ]]; then
    return
  fi
  run_uv sync --frozen --python "${UV_PYTHON_VERSION}"
}

validate_port() {
  local name="$1"
  local value="$2"
  if ! [[ "${value}" =~ ^[0-9]+$ ]] || [[ "${value}" -lt 1 || "${value}" -gt 65535 ]]; then
    echo "${name} must be a port from 1 to 65535, got '${value}'." >&2
    exit 2
  fi
}

env_file_value() {
  local file="$1"
  local key="$2"
  if [[ ! -f "${file}" ]]; then
    return
  fi
  awk -F= -v key="${key}" '$1 == key {print substr($0, length(key) + 2); exit}' "${file}"
}

upsert_env() {
  local file="$1"
  local key="$2"
  local value="$3"
  local tmp_file
  tmp_file="$(mktemp)"
  if [[ -f "${file}" ]]; then
    awk -F= -v key="${key}" -v value="${value}" '
      BEGIN { done = 0 }
      $1 == key { print key "=" value; done = 1; next }
      { print }
      END { if (!done) print key "=" value }
    ' "${file}" > "${tmp_file}"
  else
    printf '%s=%s\n' "${key}" "${value}" > "${tmp_file}"
  fi
  mv "${tmp_file}" "${file}"
}

configure_env_file() {
  local repo_root="$1"
  local env_file="${repo_root}/.env"
  local web_port="${WEB_PORT_OVERRIDE:-$(env_file_value "${env_file}" WEB_PORT)}"
  local coordinator_port="${COORDINATOR_PORT_OVERRIDE:-$(env_file_value "${env_file}" COORDINATOR_PORT)}"
  local agent_port="${AGENT_PORT_OVERRIDE:-$(env_file_value "${env_file}" AGENT_PORT)}"

  web_port="${web_port:-5000}"
  coordinator_port="${coordinator_port:-7000}"
  agent_port="${agent_port:-7001}"

  validate_port WEB_PORT "${web_port}"
  validate_port COORDINATOR_PORT "${coordinator_port}"
  validate_port AGENT_PORT "${agent_port}"

  upsert_env "${env_file}" STREAM_SERVICE all
  upsert_env "${env_file}" WEB_HOST 0.0.0.0
  upsert_env "${env_file}" WEB_PORT "${web_port}"
  upsert_env "${env_file}" COORDINATOR_HOST 0.0.0.0
  upsert_env "${env_file}" COORDINATOR_PORT "${coordinator_port}"
  upsert_env "${env_file}" AGENT_HOST 0.0.0.0
  upsert_env "${env_file}" AGENT_PORT "${agent_port}"
}

install_launcher() {
  local repo_root="$1"
  mkdir -p "${BIN_DIR}"
  local launcher="${BIN_DIR}/omni-stream"
  cat > "${launcher}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "${repo_root}"
export UV_PYTHON="\${OMNI_STREAM_PYTHON:-\${UV_PYTHON:-${UV_PYTHON_VERSION}}}"
if command -v uv >/dev/null 2>&1; then
  exec uv run python omni_stream_cli.py "\$@"
fi
exec "${PYTHON_BIN:-python3}" -m uv run python omni_stream_cli.py "\$@"
EOF
  chmod +x "${launcher}"
  echo "Installed launcher: ${launcher}"
}

ensure_path() {
  mkdir -p "${BIN_DIR}"
  local path_was_present=0
  case ":${PATH}:" in
    *":${BIN_DIR}:"*) path_was_present=1 ;;
  esac
  export PATH="${BIN_DIR}:${PATH}"
  if [[ "${path_was_present}" -eq 1 ]]; then
    return
  fi

  local profile=""
  local shell_name
  shell_name="$(basename "${SHELL:-}")"
  case "${shell_name}" in
    zsh) profile="${HOME}/.zshrc" ;;
    bash) profile="${HOME}/.bashrc" ;;
    *) profile="${HOME}/.profile" ;;
  esac

  local path_entry="${BIN_DIR}"
  if [[ "${BIN_DIR}" == "${HOME}/.local/bin" ]]; then
    path_entry='$HOME/.local/bin'
  fi

  mkdir -p "$(dirname "${profile}")"
  touch "${profile}"
  if ! grep -F "${path_entry}" "${profile}" >/dev/null 2>&1; then
    {
      printf '\n# Omni Stream CLI\n'
      printf 'export PATH="%s:$PATH"\n' "${path_entry}"
    } >> "${profile}"
    echo "Added ${BIN_DIR} to PATH in ${profile}."
  fi
}

copy_source_from_archive() {
  local repo_root="$1"
  local temp_dir
  temp_dir="$(mktemp -d)"
  trap 'rm -rf "${temp_dir}"' RETURN

  local archive="${temp_dir}/source.tar.gz"
  local tarball_url
  local archive_base="${REPO_URL%.git}"
  if [[ "${archive_base}" == git@github.com:* ]]; then
    archive_base="https://github.com/${archive_base#git@github.com:}"
  fi
  tarball_url="${archive_base}/archive/${BRANCH}.tar.gz"

  echo "Downloading ${tarball_url}"
  if have_cmd curl; then
    curl -fsSL "${tarball_url}" -o "${archive}"
  elif have_cmd wget; then
    wget -qO "${archive}" "${tarball_url}"
  else
    echo "curl or wget is required to install from the public repo." >&2
    exit 1
  fi

  mkdir -p "${temp_dir}/src"
  tar -xzf "${archive}" -C "${temp_dir}/src" --strip-components=1

  mkdir -p "${repo_root}"
  if [[ -n "$(find "${repo_root}" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]] \
    && [[ ! -f "${repo_root}/.omni-stream-install" ]]; then
    echo "${repo_root} is not empty and does not look like an Omni Stream install." >&2
    echo "Choose another directory with --install-dir." >&2
    exit 1
  fi

  find "${repo_root}" -mindepth 1 -maxdepth 1 ! -name ".env" -exec rm -rf {} +
  cp -R "${temp_dir}/src/." "${repo_root}/"
  touch "${repo_root}/.omni-stream-install"
}

detect_local_repo() {
  local source="${BASH_SOURCE[0]:-$0}"
  local script_dir
  script_dir="$(cd "$(dirname "${source}")" >/dev/null 2>&1 && pwd -P || true)"
  if [[ -n "${script_dir}" && -f "${script_dir}/../pyproject.toml" ]]; then
    cd "${script_dir}/.."
    pwd -P
    return 0
  fi
  return 1
}

bootstrap_repo() {
  local repo_root="$1"
  cd "${repo_root}"
  ensure_python
  if [[ -n "${PYTHON_BIN}" ]]; then
    "${PYTHON_BIN}" --version
  else
    echo "Using uv-managed Python runtime."
  fi
  if ! ensure_uv; then
    echo "uv installation failed. Install uv manually from https://docs.astral.sh/uv/getting-started/installation/" >&2
    exit 1
  fi
  sync_dependencies
}

if local_repo="$(detect_local_repo)"; then
  configure_env_file "${local_repo}"
  bootstrap_repo "${local_repo}"
  install_launcher "${local_repo}"
  ensure_path
  echo "Bootstrap complete."
  echo "Run 'omni-stream' to start, or 'omni-stream --help' for CLI commands."
  if [[ "${SKIP_SYNC}" -eq 1 ]]; then
    echo "Run 'uv sync --frozen --python ${UV_PYTHON_VERSION}' when you are ready."
  fi
  exit 0
fi

INSTALL_DIR="$(mkdir -p "${INSTALL_DIR}" && cd "${INSTALL_DIR}" && pwd -P)"
copy_source_from_archive "${INSTALL_DIR}"
configure_env_file "${INSTALL_DIR}"
bootstrap_repo "${INSTALL_DIR}"
install_launcher "${INSTALL_DIR}"
ensure_path

echo "Install complete."
echo "Open locally: http://127.0.0.1:$(env_file_value "${INSTALL_DIR}/.env" WEB_PORT)/"
echo "Run 'omni-stream' to start, or 'omni-stream --help' for CLI commands."

if [[ "${RUN_AFTER_INSTALL}" -eq 1 ]]; then
  echo "Starting Omni Stream. Press Ctrl+C to stop."
  exec "${BIN_DIR}/omni-stream"
fi
