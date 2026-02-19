from __future__ import annotations

import os
import threading
import webbrowser

from stream_server import create_app

app = create_app()


if __name__ == "__main__":
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", str(app.config.get("PORT", 5000))))
    auto_open_browser = os.environ.get("STREAM_NO_BROWSER", "").strip() != "1" and bool(
        app.config.get("AUTO_OPEN_BROWSER", True)
    )
    if auto_open_browser:
        threading.Timer(1.0, lambda: webbrowser.open(f"http://127.0.0.1:{port}/", new=2)).start()

    app.run(
        host=host,
        port=port,
        debug=os.environ.get("FLASK_DEBUG") == "1",
    )
