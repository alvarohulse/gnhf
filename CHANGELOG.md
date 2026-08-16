# Changelog

## [0.1.45](https://github.com/alvarohulse/gnhf/compare/gnhf-v0.1.44...gnhf-v0.1.45) (2026-08-16)


### Features

* **cli:** Add explicit worktree preservation ([061ff13](https://github.com/alvarohulse/gnhf/commit/061ff134c8093098c9ce350bef8e614597af3fdd))
* **cli:** Harden unattended run preservation and limits ([d00683b](https://github.com/alvarohulse/gnhf/commit/d00683bdef48ebb8bd76bc228266bef3acb4c7f0))
* **limits:** Stop on harness-reported cost ([c770004](https://github.com/alvarohulse/gnhf/commit/c77000471da88a446f2dadef169d8dee01537b96))


### Bug Fixes

* **acp:** Keep unavailable usage unestimated ([c17665f](https://github.com/alvarohulse/gnhf/commit/c17665fc0c43fe258282fa0f241729d2d2371fa1))
* **acp:** Reuse settled runtime after stream errors ([8a1ff7f](https://github.com/alvarohulse/gnhf/commit/8a1ff7fddb43f70296948124090b3b12534af69e))
* **agents:** Adopt tracked cross-platform shutdown ([693c17b](https://github.com/alvarohulse/gnhf/commit/693c17b699a5d1c5d08f5d53a3f944158754ce27))
* **agents:** Restrict process cleanup ownership ([0bdee44](https://github.com/alvarohulse/gnhf/commit/0bdee44d0af25822422a2a36dd83a86b365a8c7f))
* **agents:** Start Windows cleanup before final exit ([79ca74c](https://github.com/alvarohulse/gnhf/commit/79ca74c58ac276723f6b4c6154101e9259f3575c))
* **agents:** Surface cleanup uncertainty and terminal costs ([c7c3498](https://github.com/alvarohulse/gnhf/commit/c7c3498d666e89ba437af0e5b4333336e0dba369))
* **cli:** Limit worktree preservation to commit failures ([b73e745](https://github.com/alvarohulse/gnhf/commit/b73e7453f20ae38af192915875cf082cde281e28))
* **cli:** Persist supervised worktree identity ([ef12d87](https://github.com/alvarohulse/gnhf/commit/ef12d87469c791983b339f239c99b321c48cb2c8))
* **cli:** Persist worktree identity before run setup ([875ba95](https://github.com/alvarohulse/gnhf/commit/875ba95e0d71498e0b7f275b9ea396b95209cc63))
* **cli:** Preserve unsafe worktrees on shutdown ([f577fe0](https://github.com/alvarohulse/gnhf/commit/f577fe0334d0b634e992460a6bbcbc8d04310beb))
* **cli:** Preserve worktrees across forced shutdown ([3946ba9](https://github.com/alvarohulse/gnhf/commit/3946ba91e68cd832db2423ed2a6b060323eddcc1))
* **cli:** Publish worktree receipts atomically ([066b63b](https://github.com/alvarohulse/gnhf/commit/066b63b027ff49af1e9cf114c474a5e20d901c71))
* **cli:** Re-exec before worktree creation ([43a6d1d](https://github.com/alvarohulse/gnhf/commit/43a6d1d917d25e6d336bb24c3a4a06a680e680f2))
* **core:** Preserve recovery work and terminal cost authority ([414f6ea](https://github.com/alvarohulse/gnhf/commit/414f6ea88c4a51d073a1bbb718453b26aa210a13))
* **cursor:** Defer Windows cleanup through result grace ([a420d78](https://github.com/alvarohulse/gnhf/commit/a420d7849de3c866ca1c76a6dbf953949ae5f024))
* **cursor:** Stay inside an external supervisor group ([2988df1](https://github.com/alvarohulse/gnhf/commit/2988df1d1eb5b5a4bd083532efd22782bdc83c68))
* **limits:** Enforce cost caps from terminal receipts ([18a3a6e](https://github.com/alvarohulse/gnhf/commit/18a3a6e57d1a81411f51fa08eed272f3bcc844e5))
* **limits:** Keep terminal cost authority separate ([c036292](https://github.com/alvarohulse/gnhf/commit/c036292c6e42455cdc325aa863d2a12b21c6051e))
* **opencode:** Bind terminal output to usage receipts ([e6df6aa](https://github.com/alvarohulse/gnhf/commit/e6df6aa4f2723ccaa772cae252841922af118f29))
* **opencode:** Serialize turn cleanup and receipt identity ([2da9130](https://github.com/alvarohulse/gnhf/commit/2da91306d7c16023a53f19e23c0baa2876ec2be8))
* **orchestrator:** Persist unverified cleanup recovery ([d3615d7](https://github.com/alvarohulse/gnhf/commit/d3615d7a28677f8835f5dbb1ef516e12524557f2))
* **pi:** Drop provisional usage without terminal messages ([f781b2b](https://github.com/alvarohulse/gnhf/commit/f781b2b668a06e1f310eb74cfe10f741b9ad5b19))
* **pi:** Replace provisional usage with terminal receipts ([d471454](https://github.com/alvarohulse/gnhf/commit/d4714547ab376b8e541bd2b138015a73e8ee22b7))
* **process:** Preserve supervisor-close uncertainty ([6ae2da6](https://github.com/alvarohulse/gnhf/commit/6ae2da6e24548602d8463a24f7d685fc72091944))
* **process:** Propagate unverified cleanup state ([be3b080](https://github.com/alvarohulse/gnhf/commit/be3b080d8e903f9ed5d0fb8c4b6d4c38d4e1d47a))
* **recovery:** Persist cleanup uncertainty across resume ([b3e76a0](https://github.com/alvarohulse/gnhf/commit/b3e76a0867e75f79850f3eb4bcc29de44055f6c3))
* **recovery:** Preserve legacy commit-failure cleanup semantics ([1ea6b1d](https://github.com/alvarohulse/gnhf/commit/1ea6b1da882ab7711f30ccb382d1e630f377a81b))
* **runtime:** Accept authoritative cost corrections ([9b20547](https://github.com/alvarohulse/gnhf/commit/9b20547786973a54338545816863737f7b869d7a))
* **runtime:** Count persisted usage generations on resume ([f413bf1](https://github.com/alvarohulse/gnhf/commit/f413bf13765541a7645d2e8d6bfa0324993d415d))
* **runtime:** Fail closed on ambiguous agent cleanup ([f8580c0](https://github.com/alvarohulse/gnhf/commit/f8580c0bc8dc6aff18028f98de8335f97027bc07))
* **runtime:** Finalize managed agent shutdowns ([659a4cd](https://github.com/alvarohulse/gnhf/commit/659a4cd0d52b57b49c7edb915f519f88cdb19f39))
* **runtime:** Finalize receipts and owned shutdowns ([989a5d5](https://github.com/alvarohulse/gnhf/commit/989a5d54ad315f0986a0f7405da2f153e7767ab2))
* **runtime:** Harden process cleanup, receipts, and resumed limits ([d20165b](https://github.com/alvarohulse/gnhf/commit/d20165b743d5560508e48145911b083fc15abc8d))
* **runtime:** Harden recovery and cumulative usage accounting ([b5dbfa4](https://github.com/alvarohulse/gnhf/commit/b5dbfa4e4d92b5d271392a4665f4d630390b5900))
* **runtime:** Harden recovery, supervision, and usage receipts ([64f8193](https://github.com/alvarohulse/gnhf/commit/64f8193448363c10a328e1a7812b42c117a906cf))
* **runtime:** Harden shutdown limits and worktree evidence ([0849f7a](https://github.com/alvarohulse/gnhf/commit/0849f7ad5af418441660ac1fa04702e2c27c3302))
* **runtime:** Harden usage receipts and process shutdown ([d56b9b3](https://github.com/alvarohulse/gnhf/commit/d56b9b3bc29ec89969444ba8810077fbe2bd170a))
* **runtime:** Harden worktree, supervision, resume, and usage safety ([89079ea](https://github.com/alvarohulse/gnhf/commit/89079ea73668a12382d0f97255d634d0842d61ca))
* **runtime:** Persist usage bounds and retry managed cleanup ([224b829](https://github.com/alvarohulse/gnhf/commit/224b8298fdb8eb5f661eaf8db32e8515b6fd74fa))
* **runtime:** Preserve commit recovery and usage accounting ([c076688](https://github.com/alvarohulse/gnhf/commit/c0766881d16c018f73796e66d5a8725495ef9a7e))
* **runtime:** Preserve evidence and usage lower bounds ([3a7b2e0](https://github.com/alvarohulse/gnhf/commit/3a7b2e07b1e8b211eb7609daa6aa2ae54acd8493))
* **runtime:** Prove managed process shutdown completion ([02bc331](https://github.com/alvarohulse/gnhf/commit/02bc331a24d40ce564826a1ef7b9aaee458f3891))
* **runtime:** Retain process ownership through shutdown ([593d208](https://github.com/alvarohulse/gnhf/commit/593d20809f8e6b4a1c422883f8391e533e5f1753))
* **usage:** Mark missing Cursor tokens unavailable ([738b9f5](https://github.com/alvarohulse/gnhf/commit/738b9f522388286ede8299edf2bede1bd1ac1385))
* **usage:** Persist complete runtime receipts ([b81da9c](https://github.com/alvarohulse/gnhf/commit/b81da9ceba396efffb1b9f8150c9504ff6cc68a7))
* **usage:** Preserve complete iteration receipts ([bbc1df0](https://github.com/alvarohulse/gnhf/commit/bbc1df042d569160524eb8ce3b3022b735e3c680))
* **windows:** Preserve primary results after natural exit ([ec19ed7](https://github.com/alvarohulse/gnhf/commit/ec19ed72b57bfdcfcf73ec819662a4ee511ffa65))
* **worktree:** Preserve forced and evidence-bearing runs ([8ac543a](https://github.com/alvarohulse/gnhf/commit/8ac543af8e516f8d3cf898326eaa1e416912e15d))

## [0.1.44](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.43...gnhf-v0.1.44) (2026-08-13)


### Features

* **agents:** add native Cursor CLI support ([#203](https://github.com/kunchenguid/gnhf/issues/203)) ([06ae1cf](https://github.com/kunchenguid/gnhf/commit/06ae1cf025704fe3ca669983b0a68b8dbb99c23b))


### Bug Fixes

* **agents:** recover wrapped Pi JSON output ([#195](https://github.com/kunchenguid/gnhf/issues/195)) ([f47d916](https://github.com/kunchenguid/gnhf/commit/f47d916fd3d98d6784305fca3931c77c6e068121))
* **agents:** surface Claude CLI exit errors ([#190](https://github.com/kunchenguid/gnhf/issues/190)) ([3041614](https://github.com/kunchenguid/gnhf/commit/3041614ba7f45fc758eb156716a1343942b4a052))

## [0.1.43](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.42...gnhf-v0.1.43) (2026-07-23)


### Bug Fixes

* execute every PR body compliance event ([#180](https://github.com/kunchenguid/gnhf/issues/180)) ([1d06739](https://github.com/kunchenguid/gnhf/commit/1d0673920f3ee6427bc75805faccd02a6d614e84))
* **opencode:** time out individual server health check requests ([#177](https://github.com/kunchenguid/gnhf/issues/177)) ([6bfdcca](https://github.com/kunchenguid/gnhf/commit/6bfdcca98cfc227dec0cbe2a51b007e4252287f2))

## [0.1.42](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.41...gnhf-v0.1.42) (2026-05-13)


### Bug Fixes

* **agents:** recover copilot and opencode JSON output ([#149](https://github.com/kunchenguid/gnhf/issues/149)) ([55d2c39](https://github.com/kunchenguid/gnhf/commit/55d2c399f35b7c3da80d5328e988121d630fbc07))

## [0.1.41](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.40...gnhf-v0.1.41) (2026-05-07)


### Bug Fixes

* **agents:** recover schema-valid agent JSON output ([#145](https://github.com/kunchenguid/gnhf/issues/145)) ([b5ffc2d](https://github.com/kunchenguid/gnhf/commit/b5ffc2dde57b27199c43aae29849a7c07416fbe6))

## [0.1.40](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.39...gnhf-v0.1.40) (2026-05-06)


### Bug Fixes

* **agents:** filter unrelated OpenCode session errors ([#142](https://github.com/kunchenguid/gnhf/issues/142)) ([2093a4a](https://github.com/kunchenguid/gnhf/commit/2093a4a686b048d9a044840bc36b91154dda83f1))

## [0.1.39](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.38...gnhf-v0.1.39) (2026-05-06)


### Features

* **renderer:** render meteors beside content ([#139](https://github.com/kunchenguid/gnhf/issues/139)) ([6538a2a](https://github.com/kunchenguid/gnhf/commit/6538a2af397876f1531e593ef4c067626f6181e8))

## [0.1.38](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.37...gnhf-v0.1.38) (2026-05-06)


### Bug Fixes

* **cli:** resume same-prompt current-branch runs ([#137](https://github.com/kunchenguid/gnhf/issues/137)) ([0b6eccf](https://github.com/kunchenguid/gnhf/commit/0b6eccfa076868cc3477de2c79f36bbb4f1b0c56))

## [0.1.37](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.36...gnhf-v0.1.37) (2026-05-06)


### Features

* **cli:** add configurable meteor frequency ([#135](https://github.com/kunchenguid/gnhf/issues/135)) ([785435d](https://github.com/kunchenguid/gnhf/commit/785435d8f9cfa02cdd547dc852ee635bc6f473f9))

## [0.1.36](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.35...gnhf-v0.1.36) (2026-05-05)


### Features

* **cli:** support pushing current-branch runs ([#132](https://github.com/kunchenguid/gnhf/issues/132)) ([306bdec](https://github.com/kunchenguid/gnhf/commit/306bdec6f54b011a552985ea4a57be6bf7c2e7ac))


### Bug Fixes

* **core:** preserve commit-failure workspaces for repair ([#134](https://github.com/kunchenguid/gnhf/issues/134)) ([bfb90cc](https://github.com/kunchenguid/gnhf/commit/bfb90ccbd9a46aad3dcd39def5d2ffc3e78c65e9))

## [0.1.35](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.34...gnhf-v0.1.35) (2026-05-03)


### Bug Fixes

* **core:** retry failed commits without hooks ([#130](https://github.com/kunchenguid/gnhf/issues/130)) ([bb2c2f9](https://github.com/kunchenguid/gnhf/commit/bb2c2f9737fa5d43abaea9e3c2de0b62ea068469))

## [0.1.34](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.33...gnhf-v0.1.34) (2026-05-03)


### Features

* **cli:** print post-run exit summaries ([#126](https://github.com/kunchenguid/gnhf/issues/126)) ([f3622f5](https://github.com/kunchenguid/gnhf/commit/f3622f5ab302a8c0db04b4302fdca69bb6b6912b))


### Bug Fixes

* **core:** clarify no-mistakes review link ([#129](https://github.com/kunchenguid/gnhf/issues/129)) ([6ecd669](https://github.com/kunchenguid/gnhf/commit/6ecd6692bcd4f0f84f53244d16ecfac41c89c0da))
* **core:** keep exit summary within terminal width ([#128](https://github.com/kunchenguid/gnhf/issues/128)) ([0e65519](https://github.com/kunchenguid/gnhf/commit/0e65519f602abbbde21b817f95d5fb742a2df0df))

## [0.1.33](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.32...gnhf-v0.1.33) (2026-05-03)


### Features

* **core:** support raw ACP command specs ([#122](https://github.com/kunchenguid/gnhf/issues/122)) ([ef7bfb2](https://github.com/kunchenguid/gnhf/commit/ef7bfb2ee698d04083d5004266f52e57cafa94ac))


### Bug Fixes

* **core:** drop issue marker from default commits ([#124](https://github.com/kunchenguid/gnhf/issues/124)) ([2f99dfb](https://github.com/kunchenguid/gnhf/commit/2f99dfbd300b46175e41edae0fd35b134e45f102))

## [0.1.32](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.31...gnhf-v0.1.32) (2026-05-02)


### Miscellaneous Chores

* rebuild release with telemetry website id baked in ([b6a9920](https://github.com/kunchenguid/gnhf/commit/b6a9920edf008b1d7704f8aee3cbfc84c25793d8))

## [0.1.31](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.30...gnhf-v0.1.31) (2026-05-02)


### Features

* **agents:** add ACP agent support ([#112](https://github.com/kunchenguid/gnhf/issues/112)) ([5157712](https://github.com/kunchenguid/gnhf/commit/51577120c8005c966f4de0ae70f2d67e9b60784f))
* **agents:** support ACP registry overrides ([#117](https://github.com/kunchenguid/gnhf/issues/117)) ([8d47386](https://github.com/kunchenguid/gnhf/commit/8d473861d9596dadc5f943923f1b1da810d97690))
* **core:** add anonymous run telemetry ([#114](https://github.com/kunchenguid/gnhf/issues/114)) ([a2dca97](https://github.com/kunchenguid/gnhf/commit/a2dca9744650c019ba90faa590440f8909057ccc))


### Bug Fixes

* **agents:** count ACP thought text as output tokens ([#118](https://github.com/kunchenguid/gnhf/issues/118)) ([f8881e4](https://github.com/kunchenguid/gnhf/commit/f8881e4b8e8c39257023619396ebd73185ef287e))
* **agents:** mark ACP token estimates consistently ([#119](https://github.com/kunchenguid/gnhf/issues/119)) ([80fc97d](https://github.com/kunchenguid/gnhf/commit/80fc97d12e2535281c1fa0baa2c1f7a7b7f6ca04))
* **renderer:** clear terminal title on exit ([#115](https://github.com/kunchenguid/gnhf/issues/115)) ([9ed3172](https://github.com/kunchenguid/gnhf/commit/9ed3172b5b7c3a4d517e9a1d4a4cc5fb10a9ecce))

## [0.1.30](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.29...gnhf-v0.1.30) (2026-04-29)


### Bug Fixes

* **cli:** handle generated branch and worktree slug collisions ([#106](https://github.com/kunchenguid/gnhf/issues/106)) ([df81f78](https://github.com/kunchenguid/gnhf/commit/df81f7804e6ed12c7c34e4a920938bd1f83702bf))

## [0.1.29](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.28...gnhf-v0.1.29) (2026-04-29)


### Bug Fixes

* **agents:** extend Rovo Dev startup timeout ([#104](https://github.com/kunchenguid/gnhf/issues/104)) ([0b2bbe5](https://github.com/kunchenguid/gnhf/commit/0b2bbe52f9398fa8028b514252918243b4f7f8f5))

## [0.1.28](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.27...gnhf-v0.1.28) (2026-04-29)


### Bug Fixes

* **core:** abort immediately on Claude low credit ([#102](https://github.com/kunchenguid/gnhf/issues/102)) ([28f54bb](https://github.com/kunchenguid/gnhf/commit/28f54bb939a098e463c40cefb0683da897b999e6))

## [0.1.27](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.26...gnhf-v0.1.27) (2026-04-29)


### Features

* Add support for Pi coding agent ([#97](https://github.com/kunchenguid/gnhf/issues/97)) ([380de4e](https://github.com/kunchenguid/gnhf/commit/380de4e97ea4d08517cf8fa0352b3db035c6517b))
* graceful shutdown on first ctrl+c ([#88](https://github.com/kunchenguid/gnhf/issues/88)) ([385211d](https://github.com/kunchenguid/gnhf/commit/385211d7e460d8a3abd273f40b69b01eb368b690))
* **worktree:** resume into a preserved worktree on re-invocation ([#76](https://github.com/kunchenguid/gnhf/issues/76)) ([f0e05f3](https://github.com/kunchenguid/gnhf/commit/f0e05f3a819b396367415942715b755a2ac62b33))


### Bug Fixes

* **cli:** persist stop-when on resume ([#100](https://github.com/kunchenguid/gnhf/issues/100)) ([0051228](https://github.com/kunchenguid/gnhf/commit/00512284b8bd7d71e421a0bd408d7ed7bb418172))

## [0.1.26](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.25...gnhf-v0.1.26) (2026-04-24)


### Bug Fixes

* **agents:** preserve final Claude output before forced shutdown ([#93](https://github.com/kunchenguid/gnhf/issues/93)) ([61e37a8](https://github.com/kunchenguid/gnhf/commit/61e37a87ea3811e16f1e04ba7dd38db8ce94a011))

## [0.1.25](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.24...gnhf-v0.1.25) (2026-04-23)


### Bug Fixes

* **cli:** preserve run history when updating a resumed prompt ([#91](https://github.com/kunchenguid/gnhf/issues/91)) ([61306e9](https://github.com/kunchenguid/gnhf/commit/61306e9a2a29f8ebd6885f1fe02bdf1fd3b8917b))
* **core:** preserve agent output and back off only on hard errors ([#89](https://github.com/kunchenguid/gnhf/issues/89)) ([b369ae8](https://github.com/kunchenguid/gnhf/commit/b369ae80fd752d11729046d971a5ab09be18c394))

## [0.1.24](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.23...gnhf-v0.1.24) (2026-04-23)


### Bug Fixes

* **agents:** make stop output schema conditional on --stop-when ([#82](https://github.com/kunchenguid/gnhf/issues/82)) ([36f69e8](https://github.com/kunchenguid/gnhf/commit/36f69e8d480f259b0142eb5aa9e1b25ad69f09cc))
* **cli:** handle resume prompt overwrite from the controlling terminal ([#77](https://github.com/kunchenguid/gnhf/issues/77)) ([cc18215](https://github.com/kunchenguid/gnhf/commit/cc1821531af107adfd31253feabdd24077867110))

## [0.1.23](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.22...gnhf-v0.1.23) (2026-04-18)


### Features

* **orchestrator:** add --stop-when condition to end loop ([#74](https://github.com/kunchenguid/gnhf/issues/74)) ([3ad2c86](https://github.com/kunchenguid/gnhf/commit/3ad2c861afcc47d46037e076e9646b29a167448d))

## [0.1.22](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.21...gnhf-v0.1.22) (2026-04-17)


### Bug Fixes

* **agents:** dedupe Claude usage across repeated assistant snapshots ([#72](https://github.com/kunchenguid/gnhf/issues/72)) ([22a4728](https://github.com/kunchenguid/gnhf/commit/22a472831471b66051c27018ac8a033e3c06299d))

## [0.1.21](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.20...gnhf-v0.1.21) (2026-04-17)

### Features

- add live terminal title updates ([#70](https://github.com/kunchenguid/gnhf/issues/70)) ([f8b57d6](https://github.com/kunchenguid/gnhf/commit/f8b57d6a7640cff457f3d399b4aa1b44bb37abbe))

## [0.1.20](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.19...gnhf-v0.1.20) (2026-04-17)

### Bug Fixes

- **core:** harden git command inputs against shell injection ([#68](https://github.com/kunchenguid/gnhf/issues/68)) ([b19d778](https://github.com/kunchenguid/gnhf/commit/b19d778a1322d636e1179aa29b5fe606e7c8b0cc))

## [0.1.19](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.18...gnhf-v0.1.19) (2026-04-12)

### Bug Fixes

- **orchestrator:** handle aborts and preserve successful recordings ([#66](https://github.com/kunchenguid/gnhf/issues/66)) ([7ad041d](https://github.com/kunchenguid/gnhf/commit/7ad041ddabdd70cf18e1a20e2ed917e7372bc2da))

## [0.1.18](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.17...gnhf-v0.1.18) (2026-04-10)

### Features

- git worktree support so that it can support multiple features to one git repository ([#63](https://github.com/kunchenguid/gnhf/issues/63)) ([bf9e3d8](https://github.com/kunchenguid/gnhf/commit/bf9e3d86899e6f3c6421605566849d110b55c1db))

## [0.1.17](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.16...gnhf-v0.1.17) (2026-04-10)

### Bug Fixes

- **iteration-prompt:** clarify notes.md instructions ([2182240](https://github.com/kunchenguid/gnhf/commit/218224073890831d667850272b4234f6fefc68b8))

## [0.1.16](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.15...gnhf-v0.1.16) (2026-04-09)

### Features

- **codex:** allow per-agent cli arg overrides ([#58](https://github.com/kunchenguid/gnhf/issues/58)) ([4c1731e](https://github.com/kunchenguid/gnhf/commit/4c1731e0f1fc321d3ac63818bffe6dd245ed3dbe))

## [0.1.15](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.14...gnhf-v0.1.15) (2026-04-08)

### Bug Fixes

- Normalize changes and learnings to avoid JSON schema non-adherence to break the notes.md file ([#59](https://github.com/kunchenguid/gnhf/issues/59)) ([3b1427b](https://github.com/kunchenguid/gnhf/commit/3b1427b8eeaac7463da95c358e4bf8a510542772))

## [0.1.14](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.13...gnhf-v0.1.14) (2026-04-07)

### Features

- **agents:** use prompt_async endpoint instead of blocking /message ([#56](https://github.com/kunchenguid/gnhf/issues/56)) ([ef5d6d3](https://github.com/kunchenguid/gnhf/commit/ef5d6d3c8c6634abccaebd28db59086cb294f8ee))

## [0.1.13](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.12...gnhf-v0.1.13) (2026-04-06)

### Features

- **core:** add detailed error logging ([#54](https://github.com/kunchenguid/gnhf/issues/54)) ([84eaa15](https://github.com/kunchenguid/gnhf/commit/84eaa15e740d35e81508a4dce91405656eb34ff3))

## [0.1.12](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.11...gnhf-v0.1.12) (2026-04-05)

### Bug Fixes

- **cli:** clarify loop prompts and abort UI ([#26](https://github.com/kunchenguid/gnhf/issues/26)) ([90022c1](https://github.com/kunchenguid/gnhf/commit/90022c1df1d0456d67255c6d36dec968ffa9e943))

## [0.1.11](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.10...gnhf-v0.1.11) (2026-04-04)

### Features

- **config:** add agent path overrides ([#24](https://github.com/kunchenguid/gnhf/issues/24)) ([c8a71c6](https://github.com/kunchenguid/gnhf/commit/c8a71c61019fd4795dabe3e5bdda4e7a44771855))

## [0.1.10](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.9...gnhf-v0.1.10) (2026-04-03)

### Features

- **renderer:** adapt content to viewport ([#20](https://github.com/kunchenguid/gnhf/issues/20)) ([592d80b](https://github.com/kunchenguid/gnhf/commit/592d80b6d9befb9a38f44cc19346e736c01a5220))
- **renderer:** randomize star field seeds ([#22](https://github.com/kunchenguid/gnhf/issues/22)) ([e658f32](https://github.com/kunchenguid/gnhf/commit/e658f32004bc54b66ef3c23fec85857f1132fece))

## [Unreleased]

### Features

- **config:** allow per-agent binary path overrides
- **renderer:** randomize star field seeds between runs
- **renderer:** update the terminal title with live run status and restore it on exit

### Bug Fixes

- **agents:** support Windows cmd/bat agent wrappers and terminate overridden agent processes cleanly
- **agents:** deduplicate repeated Claude assistant usage snapshots so live token totals and max-token enforcement stay accurate
- **cli:** keep the final interactive TUI visible after aborted runs until the user exits
- **core:** harden git command execution so commit messages, branch names, and worktree paths are passed without shell interpretation
- **renderer:** keep wide Unicode graphemes wrapped and aligned in the live terminal UI

## [0.1.9](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.8...gnhf-v0.1.9) (2026-04-03)

### Features

- **sleep:** prevent system sleep during runs ([#17](https://github.com/kunchenguid/gnhf/issues/17)) ([091d9d3](https://github.com/kunchenguid/gnhf/commit/091d9d31b80a4c1b3c01fd7e65009ad86d864ec1))

## [0.1.8](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.7...gnhf-v0.1.8) (2026-04-02)

### Bug Fixes

- **schema:** enforce strict output schema ([#14](https://github.com/kunchenguid/gnhf/issues/14)) ([085aef7](https://github.com/kunchenguid/gnhf/commit/085aef74ba647a582aa280697213790abfa49cfa))

## [0.1.7](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.6...gnhf-v0.1.7) (2026-04-01)

### Features

- add RovoDev agent support ([#11](https://github.com/kunchenguid/gnhf/issues/11)) ([484d989](https://github.com/kunchenguid/gnhf/commit/484d989a632aebef27b4592f96ffd7fd4f25fde0))
- **opencode:** add OpenCode agent integration ([#13](https://github.com/kunchenguid/gnhf/issues/13)) ([aa9a2a5](https://github.com/kunchenguid/gnhf/commit/aa9a2a5cecbfe95abe6830dff40750aa03ee0423))

## [0.1.6](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.5...gnhf-v0.1.6) (2026-04-01)

### Features

- **cli:** add iteration and token caps ([#9](https://github.com/kunchenguid/gnhf/issues/9)) ([b92e9ac](https://github.com/kunchenguid/gnhf/commit/b92e9aca196647b19c854b722551e401c4ce72a7))

## [0.1.5](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.4...gnhf-v0.1.5) (2026-04-01)

### Bug Fixes

- **cli:** show friendly non-git error ([#7](https://github.com/kunchenguid/gnhf/issues/7)) ([65acf6b](https://github.com/kunchenguid/gnhf/commit/65acf6be343b805b99a6011d1562ac54b05b6760))

## [0.1.4](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.3...gnhf-v0.1.4) (2026-04-01)

### Features

- **core:** track branch commits from run base ([#5](https://github.com/kunchenguid/gnhf/issues/5)) ([dce09e6](https://github.com/kunchenguid/gnhf/commit/dce09e6a0a47644a174428c7a29b6e19f189486b))

## [0.1.3](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.2...gnhf-v0.1.3) (2026-03-31)

### Bug Fixes

- **cli:** correct version flag ([a1203ca](https://github.com/kunchenguid/gnhf/commit/a1203caf8a6fbb794b8a954b4acdf79ebba2ebd8))

## [0.1.2](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.1...gnhf-v0.1.2) (2026-03-31)

### Bug Fixes

- repo field in package json ([d635f42](https://github.com/kunchenguid/gnhf/commit/d635f42286f2a2904752d3d06319e2950d992934))

## [0.1.1](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.0...gnhf-v0.1.1) (2026-03-31)

### Features

- initial commit ([c8ae6d2](https://github.com/kunchenguid/gnhf/commit/c8ae6d21f4cf0b493386c00bdaa023b947d02451))

### Bug Fixes

- update README and lower maxConsecutiveFailures to 3 ([ad8925b](https://github.com/kunchenguid/gnhf/commit/ad8925b93e80e62af615eff7fc56e8399cdee4b8))
