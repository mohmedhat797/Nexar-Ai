# Demo project onboarding guide

The Demo project is a synthetic example project that ships with Nexar. `config/nexar.config.example.json` refers to it, and it contains no real data. This guide is for new contributors. It describes what the project is, how it is laid out, and what to do first.

## Overview

- The README describes the project as a synthetic example used by `config/nexar.config.example.json`.
- `docs/overview.md` describes itself as a synthetic overview that exists only to demonstrate document sets.
- Nothing in the project is production code or real data.

## Architecture or structure

The project is a small set of Markdown files. It contains no source code.

| Path | Purpose |
| --- | --- |
| `README.md` | One-paragraph description of the project |
| `docs/overview.md` | Placeholder overview used to demonstrate document sets |
| `docs/sow-instructions.md` | Present in the project. I did not read it for this guide, so its purpose is unconfirmed. |

The project lives at `examples/demo-project` inside the Nexar repository.

## Key concepts

- **Document set**: a group of project files that Nexar can read as reference material. `docs/overview.md` exists to demonstrate this.
- **Example config**: `config/nexar.config.example.json` points at this project. Assumption: the config's project entry is what makes Nexar treat this directory as a project. I did not read the config file.

## How it works

Assumption: a Nexar workflow, such as Technical Documentation, is given a project and a list of reference files. It reads those files and produces a draft document. This guide was produced that way from `README.md` and `docs/overview.md`.

## Getting started

1. Clone the Nexar repository and open `examples/demo-project`.
2. Read `README.md` and `docs/overview.md`. They are each only a few lines long.
3. To work with the wider Nexar system, use the commands in the repository's `CLAUDE.md`:

```bash
pnpm install          # Node >= 22.19, pnpm 10
pnpm check            # format:check → lint → typecheck → test → build (the CI gate)
pnpm build && node apps/cli/dist/main.js doctor
```

4. Follow the repository's git rules. Work on a feature branch, make one Conventional Commit per logical change, and open a PR to `main`. Never force-push.

## Configuration

This project has no configuration of its own. The only related file is `config/nexar.config.example.json` in the repository root.

Config files hold credential references, never secret values.

## Operations (run, monitor, troubleshoot)

There is nothing to run or monitor in this project. If a workflow cannot find the project, check that `config/nexar.config.example.json` refers to this directory. That is an assumption, because I did not open the config.

## Security considerations

- Do not add real data, secrets, tokens or `.env` files to this project.
- Keep the content synthetic.

## Known limitations

- The project is a demonstration. Its documents are placeholders with minimal content.
- It has no code, tests or build steps of its own.

## Further reading

- `README.md`
- `docs/overview.md`
- The repository's `CLAUDE.md`, plus `docs/architecture/overview.md` and `docs/architecture/security.md`. I did not read the two architecture files.

## Open questions

- What is `docs/sow-instructions.md` for, and should new contributors follow it?
- Exactly how does `config/nexar.config.example.json` use this project?
- Who owns and maintains this example?
