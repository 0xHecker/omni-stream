from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import ipaddress
import os
import socket
import time
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request


def _is_valid_ipv4(value: str) -> bool:
    try:
        parsed = ipaddress.ip_address(value)
    except ValueError:
        return False
    return parsed.version == 4 and not parsed.is_unspecified and not parsed.is_multicast


def _rank_ipv4(value: str) -> tuple[int, str]:
    parsed = ipaddress.ip_address(value)
    if parsed.is_loopback:
        return (5, value)
    if parsed.is_link_local:
        return (4, value)

    text = str(parsed)
    # Prefer home-LAN ranges first to avoid selecting virtual adapter ranges.
    if text.startswith("192.168."):
        return (0, value)
    if text.startswith("10."):
        return (1, value)
    if text.startswith("172."):
        return (2, value)

    if parsed.is_private:
        return (3, value)
    return (3, value)


def _rank_host(value: str) -> tuple[int, str]:
    host = str(value or "").strip().lower()
    if not host:
        return (9, host)
    if host == "localhost":
        return (5, host)
    try:
        return _rank_ipv4(host)
    except ValueError:
        return (8, host)


def _rank_url_host(url: str) -> tuple[int, str]:
    parsed = urllib_parse.urlparse(url)
    return _rank_host(parsed.hostname or "")


def _normalize_base_url(raw_value: str, *, default_port: int) -> str:
    raw = str(raw_value or "").strip()
    if not raw:
        return ""
    with_protocol = raw if raw.lower().startswith(("http://", "https://")) else f"http://{raw}"
    try:
        parsed = urllib_parse.urlparse(with_protocol)
    except ValueError:
        return ""
    host = str(parsed.hostname or "").strip()
    if not host:
        return ""
    if ":" in host:
        return ""
    scheme = parsed.scheme if parsed.scheme in {"http", "https"} else "http"
    try:
        parsed_port = parsed.port
    except ValueError:
        return ""
    port = parsed_port or int(default_port)
    return f"{scheme}://{host}:{port}".rstrip("/")


def _ordered_unique(items: list[str]) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []
    for value in items:
        if value in seen:
            continue
        seen.add(value)
        output.append(value)
    return output


def _parse_cidr_list(raw_value: str) -> list[ipaddress.IPv4Network]:
    networks: list[ipaddress.IPv4Network] = []
    for token in str(raw_value or "").split(","):
        value = token.strip()
        if not value:
            continue
        try:
            network = ipaddress.ip_network(value, strict=False)
        except ValueError:
            continue
        if isinstance(network, ipaddress.IPv4Network):
            networks.append(network)
    return networks


def _collect_candidate_ipv4() -> list[str]:
    candidates: list[str] = []

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("8.8.8.8", 80))
            candidates.append(str(probe.getsockname()[0]))
    except OSError:
        pass

    try:
        host = socket.gethostname()
        for addr in socket.gethostbyname_ex(host)[2]:
            candidates.append(str(addr))
    except OSError:
        pass

    try:
        host = socket.gethostname()
        for family, _type, _proto, _canon, sockaddr in socket.getaddrinfo(host, None, family=socket.AF_INET):
            if sockaddr:
                candidates.append(str(sockaddr[0]))
    except OSError:
        pass

    return candidates


def local_ipv4_addresses(*, include_loopback: bool = False) -> list[str]:
    filtered: list[str] = []
    seen: set[str] = set()
    for candidate in _collect_candidate_ipv4():
        if not _is_valid_ipv4(candidate):
            continue
        if candidate in seen:
            continue
        seen.add(candidate)
        filtered.append(candidate)

    ranked = sorted(filtered, key=_rank_ipv4)
    if include_loopback:
        return ranked

    without_loopback = [addr for addr in ranked if not ipaddress.ip_address(addr).is_loopback]
    if without_loopback:
        return without_loopback
    return ["127.0.0.1"]


def preferred_lan_ipv4() -> str:
    for candidate in local_ipv4_addresses(include_loopback=False):
        parsed = ipaddress.ip_address(candidate)
        if parsed.is_private and not parsed.is_loopback:
            return candidate

    fallback = local_ipv4_addresses(include_loopback=True)
    if fallback:
        return fallback[0]
    return "127.0.0.1"


def coordinator_discovery_hosts(*, limit_per_subnet: int = 254) -> list[str]:
    hosts: list[str] = []
    seen_hosts: set[str] = set()
    seen_subnets: set[str] = set()
    include_cidrs = _parse_cidr_list(os.environ.get("STREAM_DISCOVERY_INCLUDE_CIDRS", ""))
    exclude_cidrs = _parse_cidr_list(os.environ.get("STREAM_DISCOVERY_EXCLUDE_CIDRS", ""))

    for addr in local_ipv4_addresses(include_loopback=False):
        parsed = ipaddress.ip_address(addr)
        if not parsed.is_private:
            continue
        if include_cidrs and not any(parsed in network for network in include_cidrs):
            continue
        if any(parsed in network for network in exclude_cidrs):
            continue
        subnet = ipaddress.ip_network(f"{addr}/24", strict=False)
        subnet_key = str(subnet)
        if subnet_key in seen_subnets:
            continue
        seen_subnets.add(subnet_key)

        count = 0
        for host in subnet.hosts():
            if count >= max(1, int(limit_per_subnet)):
                break
            text = str(host)
            if text in seen_hosts:
                continue
            seen_hosts.add(text)
            hosts.append(text)
            count += 1

    return hosts


def _coordinator_probe(url: str, timeout_seconds: float) -> str | None:
    request = urllib_request.Request(url, headers={"Accept": "application/json", "User-Agent": "stream-local-discovery"})
    try:
        with urllib_request.urlopen(request, timeout=timeout_seconds) as response:
            body = response.read()
    except (urllib_error.URLError, TimeoutError, OSError):
        return None

    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    if str(payload.get("service") or "").strip().lower() != "coordinator":
        return None
    return url.rstrip("/")


def coordinator_seed_urls(*, port: int = 7000) -> list[str]:
    seed_values: list[str] = [
        os.environ.get("STREAM_DEFAULT_COORDINATOR_URL", ""),
        os.environ.get("STREAM_LOCAL_COORDINATOR_URL", ""),
        os.environ.get("AGENT_COORDINATOR_URL", ""),
    ]
    hints_raw = os.environ.get("STREAM_COORDINATOR_HINTS", "").strip()
    if hints_raw:
        seed_values.extend(part.strip() for part in hints_raw.split(","))

    seed_values.extend([f"http://127.0.0.1:{int(port)}", f"http://localhost:{int(port)}"])
    for addr in local_ipv4_addresses(include_loopback=False):
        seed_values.append(f"http://{addr}:{int(port)}")

    normalized = [
        _normalize_base_url(value, default_port=int(port))
        for value in seed_values
    ]
    urls = [value for value in normalized if value]
    return _ordered_unique(sorted(urls, key=_rank_url_host))


def _probe_coordinator_urls(
    urls: list[str],
    *,
    timeout_seconds: float,
    max_workers: int,
    max_results: int,
    seen: set[str] | None = None,
) -> list[str]:
    if not urls or max_results <= 0:
        return []

    seen_values = set(seen or set())
    workers = max(4, min(int(max_workers), max(8, len(urls))))
    discovered: list[str] = []
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {
            executor.submit(_coordinator_probe, url, timeout_seconds): url
            for url in urls
        }
        for future in as_completed(futures):
            value = future.result()
            if not value or value in seen_values:
                continue
            seen_values.add(value)
            discovered.append(value)
            if len(discovered) >= max_results:
                break
    return discovered


_DISCOVERY_CACHE: dict[tuple[int, int, int, int], tuple[float, list[str]]] = {}


def discover_coordinators(
    *,
    port: int = 7000,
    timeout_seconds: float = 0.18,
    max_workers: int = 64,
    max_results: int = 8,
    cache_ttl_seconds: float = 6.0,
) -> list[str]:
    safe_port = int(port)
    safe_timeout = max(0.05, float(timeout_seconds))
    safe_workers = max(8, int(max_workers))
    safe_results = max(1, int(max_results))
    safe_ttl = max(0.0, float(cache_ttl_seconds))
    cache_key = (safe_port, int(safe_timeout * 1000), safe_workers, safe_results)

    now = time.monotonic()
    cached = _DISCOVERY_CACHE.get(cache_key)
    if cached and safe_ttl > 0 and (now - cached[0]) < safe_ttl:
        return list(cached[1])

    discovered: list[str] = []
    seen: set[str] = set()

    seed_urls = coordinator_seed_urls(port=safe_port)
    direct_probe_urls = [f"{url.rstrip('/')}/" for url in seed_urls]
    direct_probe_timeout = min(0.35, max(0.08, safe_timeout * 1.1))
    discovered.extend(
        _probe_coordinator_urls(
            direct_probe_urls,
            timeout_seconds=direct_probe_timeout,
            max_workers=min(safe_workers, 24),
            max_results=safe_results,
            seen=seen,
        )
    )
    seen.update(discovered)

    if len(discovered) < safe_results:
        seed_hosts = {
            str(urllib_parse.urlparse(value).hostname or "").strip()
            for value in discovered + seed_urls
        }
        scan_urls = [
            f"http://{host}:{safe_port}/"
            for host in coordinator_discovery_hosts()
            if host not in seed_hosts
        ]
        discovered.extend(
            _probe_coordinator_urls(
                scan_urls,
                timeout_seconds=safe_timeout,
                max_workers=safe_workers,
                max_results=safe_results - len(discovered),
                seen=seen,
            )
        )

    final = sorted(set(discovered), key=_rank_url_host)[:safe_results]
    _DISCOVERY_CACHE[cache_key] = (now, final)
    return final
