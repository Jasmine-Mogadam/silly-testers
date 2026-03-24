# silly-testers

AI agent framework that runs two adversarial teams against your web application simultaneously:

- **QA Team** — tests features from your list + free-form play testers that explore like real users
- **Red Team** — performs reconnaissance on your source code and attempts security exploits

Both teams have read-only access to your repo source code so they can attach file/line references to every report. Reports are written as Markdown files designed to be pasted directly into a coding LLM for fixing.

---

## Prerequisites

- **Node.js** 18+
- **[Ollama](https://ollama.com)** running locally
- Required Ollama models pulled (see below)

---

## Setup

### 1. Run setup

```bash
npm run setup
```

This installs npm packages, Playwright's Chromium browser, and pulls the required Ollama models. It will tell you what to do if Ollama isn't running yet.

If Ollama wasn't running during setup, start it and then pull the models separately:

```bash
ollama serve          # in a separate terminal, if not already running
npm run setup:models  # pulls llama3.1:8b and llava
```

### 2. Configure

Copy the example config and fill in your values:

```bash
cp config.example.yaml config.yaml
```

Edit `config.yaml` — there's only one required field:

```yaml
target:
  repo: /absolute/path/to/your-app   # absolute path to the repo being tested
```

The start command and URL are **auto-discovered** by the DevOps agent when you run — it reads your `package.json`, framework configs, and `.env` files to figure them out.

### 4. Create a feature list

```bash
cp features.example.md features.md
```

Edit `features.md` — one feature per line, e.g.:

```
User registration with email and password
Login redirects to dashboard
Password reset flow via email link
Search returns relevant results
```

Lines starting with `#` are treated as comments and ignored.

---

## Running

```bash
# Validate config + connectivity without starting agents
npm start -- --dry-run

# Run both QA and Red Team (default)
npm start

# Run only one team
npm start -- --team qa
npm start -- --team red

# Use a different config file
npm start -- --config /path/to/other-config.yaml
```

Stop with **Ctrl+C** — agents shut down gracefully and a summary is printed.

---

## How it works

### Startup sequence

1. **DevOps agent** reads your repo (static analysis, no browser) to discover the start command and URL — checks `package.json` scripts, framework configs, `.env` files, and asks the LLM if needed
2. Target server is started using the discovered command
3. **DevOps agent** (browser phase) crawls the live site to build a SiteMap and auto-configure the health monitor
4. **Watchdog** begins polling all detected services (frontend + backend separately if applicable)
5. **QA** and **Red Team** coordinators spawn their workers

### QA Team

| Agent | Role |
|---|---|
| QA Coordinator | Distributes features, adapts strategy based on findings |
| Feature Tester | Tests a set of features from your list — happy path, edge cases, error handling |
| Play Tester | Gets random user goals and explores freely (e.g., "try to post content", "find account settings") |

### Red Team

| Agent | Role |
|---|---|
| Red Coordinator | Tracks attack surface, prioritizes targets, avoids duplicate attempts |
| Recon Agent | Reads source code for routes/auth/validation gaps, crawls the live site |
| Exploit Agent | Attempts specific exploits (XSS, SQLi, IDOR, auth bypass, etc.) based on recon |

### Communication rules

- Agents communicate **within their team** via a shared channel
- QA and Red Team **cannot directly message each other** — they can only interact through the website itself (e.g., Red Team may exploit accounts that QA play testers created)

### Server crash handling

If the target server crashes during a test run:

1. Watchdog detects it and broadcasts `SITE_DOWN` — all agents pause immediately
2. Watchdog attempts restart up to 3 times (configurable)
3. On recovery: agents resume with context that the site was recently down
4. If watchdog gives up: DevOps agent runs a diagnosis and writes a recovery report, then the framework exits

---

## Reports

Reports are written to `reports/` — one Markdown file per finding:

```
reports/
├── qa/           # Bug reports and UX issues
├── red-team/     # Security vulnerability reports
└── devops/       # Server crash / recovery reports
```

Each report includes:

- **Severity** (Critical / High / Medium / Low)
- **Steps to reproduce**
- **Evidence** (page content or screenshot analysis)
- **Code references** with file paths and line numbers from your repo
- **Suggested fix** — written for a coding LLM to implement

To fix an issue, paste the report contents into your LLM of choice.

---

## Configuration reference

All options in `config.example.yaml` are documented inline. The only required field is `target.repo`. Key options:

| Option | Default | Description |
|---|---|---|
| `ollama.textModel` | `llama3.1:8b` | Model for agent reasoning |
| `ollama.visionModel` | `llava` | Model for screenshot analysis |
| `agents.qa.featureTesters` | `2` | Number of feature testers |
| `agents.qa.playTesters` | `2` | Number of play testers |
| `agents.redTeam.recon` | `1` | Number of recon agents |
| `agents.redTeam.exploit` | `2` | Number of exploit agents |
| `browser.headless` | `true` | Set to `false` to watch agents live |
| `runner.playTesterGoalIntervalMs` | `300000` | How often play testers get a new goal (ms) |
| `runner.maxRunDurationMs` | `0` | Max run time in ms; `0` = run until Ctrl+C |

---

## Network sandboxing

Once the server is running, all browser contexts are sandboxed — agents cannot make requests to external URLs. This ensures:

- Tests only affect the target site
- Exploit agents can't reach real external services
- Results are reproducible

---

## Project structure

```
src/
├── index.ts                    CLI entry point
├── runner.ts                   Orchestrator
├── watchdog.ts                 Code-only server health monitor
├── core/
│   ├── types.ts                Shared interfaces and enums
│   ├── config.ts               Config loader
│   ├── llm.ts                  Ollama client (text + vision)
│   ├── browser.ts              Playwright pool + sandboxing
│   ├── channel.ts              Team message channels
│   ├── reporter.ts             Report file writer
│   └── repo-reader.ts          Read-only repo access
└── agents/
    ├── base-agent.ts           Abstract base (all agents extend this)
    ├── base-coordinator.ts     Abstract coordinator
    ├── devops-agent.ts         Startup configuration agent
    ├── qa/
    │   ├── qa-coordinator.ts
    │   ├── feature-tester.ts
    │   └── play-tester.ts
    └── red-team/
        ├── red-coordinator.ts
        ├── recon-agent.ts
        └── exploit-agent.ts
```
