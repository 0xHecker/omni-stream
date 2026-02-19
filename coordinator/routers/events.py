from __future__ import annotations

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect, status

from shared.security import TokenError, decode_token
from shared.schemas import EventsWsTokenResponse

from ..config import load_config
from ..services.auth import AuthContext, issue_events_ws_token, require_auth_context
from ..services.events import broker

router = APIRouter(prefix="/api/v1/events", tags=["events"])


def _parse_ws_protocols(header_value: str) -> list[str]:
    return [item.strip() for item in header_value.split(",") if item.strip()]


def _extract_ws_auth(protocols: list[str]) -> tuple[str, str | None]:
    for protocol in protocols:
        if protocol.startswith("auth."):
            return protocol[5:], protocol
    return "", None


@router.websocket("/ws")
async def events_ws(websocket: WebSocket) -> None:
    config = load_config()
    offered_protocols = _parse_ws_protocols(websocket.headers.get("sec-websocket-protocol", ""))
    ws_token, auth_protocol = _extract_ws_auth(offered_protocols)
    if not ws_token:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    try:
        claims = decode_token(config.secret_key, ws_token)
    except TokenError:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    token_kind = str(claims.get("kind") or "")
    if token_kind != "events_ws":
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    principal_id = str(claims.get("principal_id") or "")
    if not principal_id:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    selected_subprotocol = next((item for item in offered_protocols if item != auth_protocol), None)
    await broker.connect(principal_id, websocket, subprotocol=selected_subprotocol)
    try:
        while True:
            await websocket.receive_text()
            await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        await broker.disconnect(principal_id, websocket)
    except Exception:  # noqa: BLE001
        await broker.disconnect(principal_id, websocket)


@router.get("/token", response_model=EventsWsTokenResponse)
def get_ws_token(auth: AuthContext = Depends(require_auth_context)) -> EventsWsTokenResponse:
    config = load_config()
    ws_token = issue_events_ws_token(config, auth.principal_id, auth.client_device_id)
    return EventsWsTokenResponse(
        ws_token=ws_token,
        expires_in=config.events_ws_token_ttl_seconds,
    )
