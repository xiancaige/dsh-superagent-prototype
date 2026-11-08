# dsh-superagent

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source

## Feishu operator commands (TP extension)

Commands run directly in the enabled Superagent Feishu Source, without an LLM call or the old communication plugin. Only listed human operators in a listened chat may use them (DM, or bot mention in a group). Commands never become tickets; ordinary requests keep the existing intake path.

- `/model [page]`: show the host model catalog and role defaults.
- `/model <provider> <model> [all|main|worker|ticket-id]`: explicitly select a model, default `all`. `main` and `worker` update role defaults and existing managed sessions; a full open ticket ID updates just that ticket's session. `/mode` is an alias. Model IDs may contain `/`; provider and model are separate arguments.
- Existing productive turns are not cancelled: the next model request uses the selection. A known quota-retry wait is cancelled with its inbox preserved and a deterministic continuation queued. Unrelated sessions and retry policy are not changed. Host `selectModel` also saves the host default, as a manual Web selection does.
- `/todo` (also `todo`): project TODO index; `/todo <number>`: detail, with checkpoint metadata removed. Requires explicit deployment `sourceRoot`. Replies are shortened to the existing IM limit; full text remains in the planboard.
- `/h` or `/help`: syntax. No old session-switch commands are enabled.

Selection failures are reported, not treated as success. A failure after defaults/earlier sessions changed may leave partial progress; resend a new command to converge. Receipt and reply IDs deduplicate live/history delivery; replay after a crash is convergent and continuation IDs are stable.

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)
