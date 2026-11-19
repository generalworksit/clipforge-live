# ClipForge Live

Chrome companion for YouTube and Twitch live highlights.

1. Start ClipForge and load this folder from **chrome://extensions → Developer mode → Load unpacked**.
2. Pin the extension and click **Connect app**.
3. Open a livestream with its chat, keep the player visible, and click **Start capture**.

Highlights arrive in **Live clips** as clean MP4s. **Save moment** (`Alt+Shift+C`) marks one manually. Defaults: 20 seconds before the reaction, 12 seconds after it settles, maximum 90 seconds.

The local connection key is saved automatically. Advanced settings retain manual pairing and a custom port. This key is separate from the YouTube API key used by the experimental background monitor.

If ClipForge is offline, finished captures wait locally; use **Retry uploads** after restarting it. Stop capture and send pending clips before reloading the extension. Then refresh the stream tab.

Keep the player visible and playing at normal speed. Ads and overlays inside the player are recorded. Detection estimates reactions; review every clip. Kick is not supported. Nothing is posted automatically.
