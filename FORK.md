# Shamwari fork of LibreChat

This is the Shamwari AI fork of [LibreChat](https://github.com/danny-avila/LibreChat)
(MIT). It is the code behind Shamwari Chat at `https://shamwari.ai/chat`.
Design, runbook and decisions: `docs/librechat.md` in
[shamwari-ai/shamwari](https://github.com/shamwari-ai/shamwari), tracked in
issue #146 there.

## Base

| | |
| --- | --- |
| Upstream | `danny-avila/LibreChat` (remote `upstream`) |
| Base release | `v0.8.8` |
| Base commit | `e8f3be08623663d4ad7f7241e693c94469b63bb0` |
| Our trunk | `shamwari/main` |
| `main` | an untouched mirror of upstream `main`. Never commit to it. |

## Rules for changes

1. **Every change has a row** in the decision table in `docs/librechat.md`
   (scope pill, citations, theme density, Servers API, locales). No row, no change.
2. **One area per commit**, so a merge conflict names its owner. Commit subjects
   start with the area: `theme:`, `scope:`, `citations:`, `servers-api:`,
   `i18n:`, `fork:`.
3. **Configuration beats code.** Anything `librechat.yaml` or an environment
   variable can do stays out of the fork. Deploy configuration lives in
   `shamwari-ai/shamwari` under `chat/librechat/`, not here.
4. **Rule 1 holds in the fork.** LibreChat is a client of the Shamwari gateway
   and must never be given a provider endpoint or credential. Do not add a
   provider integration, a direct model call, or a feature that sends a person's
   text anywhere but the gateway. Personal scope is refused by the gateway
   (`409 scope_requires_local_inference`) and the fork must show that refusal
   plainly, not hide it.
5. **Do not edit upstream files for style.** Reformatting makes every upstream
   merge harder.

## Taking an upstream release

```
git fetch upstream --tags
git checkout shamwari/main
git merge vX.Y.Z          # a merge, so our commits keep their identity
```

Then, in `shamwari-ai/shamwari`: change `chat/librechat/PIN` to the new tag and
commit, run the guard tests, and read `UPGRADING.md` for that release. Security
releases are merged first and soon; other releases at most monthly.

## Licence

LibreChat is MIT, copyright its authors (see `LICENSE`). That notice stays in
place in every build. Our additions are Apache-2.0, copyright Bundu Foundation;
see `NOTICE`.
