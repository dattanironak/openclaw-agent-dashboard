# OpenClaw Local Dashboard

A small local webapp for:

- watching tracked OpenClaw agents in a cleaner live dashboard
- seeing recent sessions and agent activity
- sending tasks to existing OpenClaw agents
- creating **local task profiles** from the UI
- tracking additional agent IDs and comparing their session/token activity
- receiving real-time UI updates via a local server-sent event stream

## Current dashboard scope

The dashboard now focuses on the operational bits that matter most:

- **Tracked agents** with live health/activity cards
- **Recent sessions** in a visual activity feed
- **Task dispatch** to existing configured OpenClaw agents
- **Local task profiles** for repeat work

Removed from the UI on purpose:

- overview summary panel
- gateway panel
- host resource panel
- top memory-hungry processes panel

## Practical recommendation

If you want something easy and reliable, use this model:

- keep **real OpenClaw agents** configured in OpenClaw itself
- create **task profiles** in the dashboard that point to those agents
- dispatch tasks from the dashboard using `openclaw agent --agent <id> --message ...`

Why this is the practical option:

- no config editing from the browser
- no gateway restart needed for every new UI profile
- less chance of breaking your OpenClaw setup
- you still get multiple “agents” in practice from the web UI

## Run locally

```bash
cd /home/ronakprivate/.openclaw/workspace/openclaw-local-dashboard
npm start
```

Then open:

```text
http://127.0.0.1:3477
```

## API routes

- `GET /api/overview` — session and tracked-agent data used by the dashboard
- `GET /api/profiles` — local task profiles
- `POST /api/profiles` — create a profile
- `DELETE /api/profiles/:id` — delete a profile
- `GET /api/agents` — tracked agent IDs
- `POST /api/agents` — add a tracked agent ID
- `DELETE /api/agents/:id` — remove a tracked agent ID
- `POST /api/tasks` — dispatch a task to an existing OpenClaw agent
- `GET /api/stream` — real-time server-sent event feed for dashboard updates

## Notes

- This server is meant for **local use**.
- It binds to `127.0.0.1` by default.
- Task dispatch currently targets existing configured agents only.
- Real-time updates are pushed every few seconds and also after task/profile/agent changes.
- Agent performance is estimated from local OpenClaw session data: session count, recent activity, total tokens, average tokens per session, last seen time, and models used.
- Gateway/session status is still gathered on the server side from local `openclaw` CLI commands, even though the low-level gateway/host panels were removed from the UI.
