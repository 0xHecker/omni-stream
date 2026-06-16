from __future__ import annotations

from pathlib import Path

import omni_stream_cli as cli


def test_cli_load_env_file_does_not_override_existing_env(monkeypatch, tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("WEB_PORT=5050\nCOORDINATOR_PORT=7050\n", encoding="utf-8")
    monkeypatch.setenv("WEB_PORT", "6000")
    monkeypatch.delenv("COORDINATOR_PORT", raising=False)

    cli.load_env_file(env_file)

    assert cli.os.environ["WEB_PORT"] == "6000"
    assert cli.os.environ["COORDINATOR_PORT"] == "7050"


def test_cli_ports_command_persists_custom_ports(monkeypatch, tmp_path: Path, capsys) -> None:
    env_file = tmp_path / ".env"
    monkeypatch.setattr(cli, "ENV_FILE", env_file)
    monkeypatch.delenv("WEB_PORT", raising=False)
    monkeypatch.delenv("COORDINATOR_PORT", raising=False)
    monkeypatch.delenv("AGENT_PORT", raising=False)

    result = cli.main(["ports", "--web", "5050", "--coordinator", "7050", "--agent", "7051"])

    assert result == 0
    content = env_file.read_text(encoding="utf-8")
    assert "WEB_PORT=5050" in content
    assert "COORDINATOR_PORT=7050" in content
    assert "AGENT_PORT=7051" in content
    assert "web         5050" in capsys.readouterr().out


def test_cli_no_args_defaults_to_start_all(monkeypatch) -> None:
    calls: list[str] = []

    def fake_start(args) -> int:
        calls.append(args.service)
        return 0

    monkeypatch.setattr(cli, "load_env_file", lambda: None)
    monkeypatch.setattr(cli, "command_start", fake_start)

    assert cli.main([]) == 0
    assert calls == ["all"]


def test_cli_service_alias_sets_command(monkeypatch) -> None:
    calls: list[str] = []

    def fake_run_service(service: str, args) -> int:
        calls.append(service)
        return 0

    monkeypatch.setattr(cli, "load_env_file", lambda: None)
    monkeypatch.setattr(cli, "_run_service", fake_run_service)

    assert cli.main(["web", "--web-port", "5050", "--no-browser"]) == 0
    assert calls == ["web"]
