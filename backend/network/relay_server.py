# relay_server.py
import asyncio
import json
import time
import logging
import websockets

CLIENTS: dict = {}   # username → {ip, port, ts, ws}
TTL_SECONDS = 120

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("relay")


def prune() -> None:
    now = time.time()
    expired = [n for n, d in list(CLIENTS.items()) if now - d["ts"] > TTL_SECONDS]
    for name in expired:
        CLIENTS.pop(name, None)
        log.info(f"Pruned {name} (TTL expired)")


async def handler(websocket):
    client_ip = websocket.remote_address[0] if websocket.remote_address else "unknown"
    registered_as = None

    try:
        async for raw in websocket:
            try:
                data = json.loads(raw)
            except Exception:
                await websocket.send(json.dumps({"ok": False, "error": "invalid_json"}))
                continue

            action = data.get("action")

            # ── Register ──────────────────────────────────────────
            if action == "register":
                username = data.get("username")
                port     = data.get("port")
                if not username or not isinstance(port, int):
                    await websocket.send(json.dumps({"ok": False, "error": "bad_register"}))
                    continue

                CLIENTS[username] = {
                    "ip":   client_ip,
                    "port": port,
                    "ts":   time.time(),
                    "ws":   websocket,
                }
                registered_as = username
                prune()
                await websocket.send(json.dumps({"ok": True}))
                log.info(f"Registered {username} @ {client_ip}:{port}  ({len(CLIENTS)} online)")

            # ── Lookup ────────────────────────────────────────────
            elif action == "lookup":
                username = data.get("username")
                prune()
                peer = CLIENTS.get(username)
                if not peer:
                    await websocket.send(json.dumps({"ok": False, "error": "not_found"}))
                    continue
                await websocket.send(json.dumps({
                    "ok":   True,
                    "peer": {"ip": peer["ip"], "port": peer["port"], "username": username},
                }))
                log.info(f"Lookup {username} → {peer['ip']}:{peer['port']}  (by {client_ip})")

            # ── List (who's online) ───────────────────────────────
            elif action == "list":
                prune()
                online = [
                    {"username": u, "ip": d["ip"], "port": d["port"]}
                    for u, d in CLIENTS.items()
                ]
                await websocket.send(json.dumps({"ok": True, "users": online}))
                log.info(f"List requested by {client_ip}: {len(online)} users online")

            # ── Forward (relay a raw message to another user) ─────
            elif action == "forward":
                target  = data.get("target")
                payload = data.get("payload", {})
                peer    = CLIENTS.get(target)
                if not peer or not peer.get("ws"):
                    await websocket.send(json.dumps({"ok": False, "error": "target_not_found"}))
                    continue
                try:
                    sender_name = registered_as or client_ip
                    fwd = json.dumps({
                        "action":  "forwarded",
                        "from":    sender_name,
                        "payload": payload,
                    })
                    await peer["ws"].send(fwd)
                    await websocket.send(json.dumps({"ok": True}))
                    log.info(f"Forwarded from {sender_name} → {target}")
                except Exception as e:
                    await websocket.send(json.dumps({"ok": False, "error": str(e)}))

            else:
                await websocket.send(json.dumps({"ok": False, "error": "unknown_action"}))
                log.warning(f"Unknown action '{action}' from {client_ip}")

    except websockets.ConnectionClosed:
        pass
    finally:
        if registered_as and CLIENTS.get(registered_as, {}).get("ws") is websocket:
            CLIENTS.pop(registered_as, None)
            log.info(f"Disconnected: {registered_as} ({client_ip})  ({len(CLIENTS)} remaining)")


async def main():
    server = await websockets.serve(
        handler, "0.0.0.0", 8765,
        ping_interval=30,
        ping_timeout=10,
    )
    log.info("Relay server started on 0.0.0.0:8765")
    await asyncio.Future()  # run forever


if __name__ == "__main__":
    asyncio.run(main())
    