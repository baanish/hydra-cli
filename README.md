# hydra-cli

hydra-cli is a multi-agent research and synthesis CLI that breaks a query into specialist workstreams, runs parallel research plus debate rounds, and produces one consolidated synthesis. it is designed for long-form, evidence-oriented questions where a single model answer is too shallow.

## install

```bash
bun install
bun link
hydra --help
```

## quick start

```bash
hydra config set synthetic-api-key <key>
# optional llm override key:
# hydra config set api-key <key>
hydra run "your query"
```

to quickly see a full real run output (the bundled AI transition 2036 retrospective) without running anything:

```bash
cat examples/ai-transition-2036.json | jq -r '.brief'
# no jq:
node -e "console.log(require('./examples/ai-transition-2036.json').brief)"
```

## key commands

| command | purpose | example |
| --- | --- | --- |
| `hydra run <query>` | start a run (also supports `hydra "<query>"`) | `hydra run "market entry strategy"` |
| `hydra run --custom-personas-only <query>` | use custom personas only (fill missing personas with ephemeral generated ones) | `hydra run --custom-personas-only --agents 5 "supply chain strategy"` |
| `hydra view <run-id>` | inspect a run summary | `hydra view Rw9k...` |
| `hydra history` | list recent runs | `hydra history --limit 20` |
| `hydra config show` | print effective config with masked keys | `hydra config show` |
| `hydra config set <key> <value>` | update a config value | `hydra config set max-concurrency 5` |
| `hydra web` | launch local web UI | `hydra web --port 3737` |

## personas

personas are specialist analytical lenses assigned to agents (for example `skeptic`, `futurist`, `economist`) to bias how perspectives are generated and debated. hydra ships with 20 built-in personas.

| command | purpose | example |
| --- | --- | --- |
| `hydra persona list` | list all personas (built-in + custom) | `hydra persona list` |
| `hydra persona list --json` | output personas as json | `hydra persona list --json` |
| `hydra persona add` | add a custom persona | `hydra persona add --name "The Lawyer" --description "Applies legal reasoning and precedent." --methodology "case law analysis"` |
| `hydra persona remove <id>` | remove a custom persona | `hydra persona remove the-lawyer` |

custom personas are stored in `~/.config/hydra-cli/personas.json`. built-in personas cannot be removed. if `--id` is not provided when adding a persona, it is auto-derived from the name using slugification.

## config options

| key | type | default |
| --- | --- | --- |
| `apiKey` | `string \| undefined` | unset |
| `syntheticApiKey` | `string \| undefined` | unset |
| `searchProvider` | `"synthetic" \| "exa" \| "brave"` | `synthetic` |
| `exaApiKey` | `string \| undefined` | unset |
| `braveApiKey` | `string \| undefined` | unset |
| `baseUrl` | `string` | `https://api.synthetic.new/openai/v1` |
| `model` | `string` | `hf:MiniMaxAI/MiniMax-M2.5` |
| `defaultAgentCount` | `number` | `5` |
| `maxConcurrency` | `number` | `5` |
| `debateRounds` | `number` | `2` |
| `searchEnabled` | `boolean` | `true` |
| `customPersonasOnly` | `boolean` | `false` |

## note on backend

hydra-cli uses Synthetic.new as the default OpenAI-compatible LLM backend (`baseUrl` + model defaults target Synthetic.new). you can override `baseUrl` and `model` for other compatible endpoints.
