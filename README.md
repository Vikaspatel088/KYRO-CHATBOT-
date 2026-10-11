# Kyro Pro

Requires Node.js 20+ and a Groq API key.

1. Open this folder in VS Code.
2. Copy `.env.example` to `.env` only when `.env` does not already exist.
3. Set `GROQ_API_KEY` to a valid Groq key in `.env`; never paste it into chat or frontend code.
4. Run `npm start` in a terminal.
5. Visit `http://localhost:3000` (do **not** open the HTML via `file://`).

No `npm install` is necessary: the backend uses built-in Node.js modules. The frontend uses CDN libraries, so internet access is required. `/api/health` checks the authenticated Groq model catalog and reports whether the configured model is accessible; it reports `connected` only after a successful chat completion. The current verified text model is `qwen/qwen3.8-27b`. The current account has no configured accessible vision model, so image requests return a clear error instead of being sent as text.

Run the dependency-free regression suite with `npm test`. This project has no bundler; production validation is performed with Node syntax checks and the automated server tests.

## Notes
- API secrets stay in `.env` on the server. Do not commit `.env` or deploy the server publicly without authentication and rate limiting.
- The browser calls only `/api/chat`; it never receives `GROQ_API_KEY`. The server selects the configured text or vision model based on the request contents.
- Conversations, titles, search, editing, deletion, and messages are stored locally in the browser. Clear or delete conversations to remove them.
- The verified text model is account-specific and currently `qwen/qwen3.8-27b`; the server checks `/openai/v1/models` before sending chat requests.
- Vision is disabled unless an accessible configured vision model is present. The current account has no verified vision model.
- Existing speech, copy, Markdown, code highlighting, and TXT export features are retained.

## Production considerations

For a localhost or trusted LAN workflow, `npm start` is sufficient. Before public deployment, add authentication, HTTPS termination, a durable per-user conversation store, centralized rate limiting, request logging that excludes prompts and credentials, and a restrictive origin policy. The current app intentionally has no authentication and stores conversation data in browser localStorage.

`npm audit` can be run when the CDN dependencies are replaced with package-managed dependencies; the current runtime has no npm dependencies and uses CDN libraries in the static page.
