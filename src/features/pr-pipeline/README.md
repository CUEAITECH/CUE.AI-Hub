# PR Pipeline

PR Pipeline owns pull request list, review drawer, human decision handling, acceptance-check streaming, and GitHub review surfaces.

Use `pullsApi` for PR reads and decisions, and `eventsApi` for realtime or grouped event streams. Keep PR payload adaptation here so the rest of the app works with stable frontend state.
