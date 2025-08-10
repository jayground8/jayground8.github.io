---
title: 'Automating Semantic Versioning and Releases in Node.js with Conventional Commits'
date: '2025-08-10'
tags: ['nodejs', 'dev']
images: ['/static/images/thumbnail/conventional-commits.png']
summary: 'I introduced several open-source tools that help ensure everyone follows the same commit message conventions and make it easy to manage versions and release notes based on those consistent messages.'
---

This time, I’d like to share how to set up a Node.js project so you and your teammates can follow the same commit message conventions. It’s not ideal to simply ask others to carefully follow guidelines when writing commit messages — mistakes will happen. Instead, you can leverage some open-source tools with Git to enforce the rules automatically, ensuring everyone follows them without errors.

Once your commit messages follow a consistent format, you can manage semantic versioning and release notes automatically based on those messages. I’ll explain more about that later.

## commitlint

First, you can use commitlint to define rules and lint your commit messages. Many of my colleagues already wrote commit messages similar to [the Conventional Commits specification](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

I also used to write messages like `feat(api): something` without realizing it matched the Conventional Commits format.

To start, install the necessary packages:

```sh
pnpm init
pnpm add -D @commitlint/cli @commitlint/config-conventional
```

Running the linter manually isn’t very practical. Instead, you can enforce commit message rules using Git’s commit-msg hook.

For managing Git hooks, there’s a great tool called Husky. Initialize it like this:

```sh
pnpm add -D husky
pnpm husky init
```

After initializing Husky, check your package.json. You’ll see that Husky added a prepare script. When a teammate clones the repository and installs dependencies, prepare will run, and Husky will set up Git hooks locally. This means that setting up the project automatically configures the hooks.

`package.json`

```json
{
  "scripts": {
    "prepare": "husky"
  }
}
```

Now, add a Husky command to run commitlint on every commit:

```bash
echo "pnpm dlx commitlint --edit \$1" > .husky/commit-msg
```

If you use Jira, you can add ticket references in the commit footer. For example, to enforce a reference prefix, add the references-empty rule to your configuration. Setting `[2, 'never']` will cause commitlint to throw an error if no reference with the PROJ- prefix is provided. If you set it to `1`, it will only warn — but in my experience, people often ignore warnings.

Note: commitlint somehow fails to parse `!:` correctly when this rule is set, so I eventually decided not to enforce it.

`.commitlintrc.yml`

```yaml
extends:
  - '@commitlint/config-conventional'
rules:
  references-empty: [2, 'never']
parserPreset:
  parserOpts:
    issuePrefixes: ['PROJ-']
```

## semantic-release

Now that everyone is guaranteed to use a consistent commit format, you can integrate semantic-release to handle semantic versioning and automatic release notes in GitHub (or other platforms).

```bash
pnpm add -D semantic-release conventional-changelog-conventionalcommits
```

Here’s an example configuration file (I’ll explain the details later):

`.releaserc.yml`

```yaml
branches:
  - 'main'
tagFormat: v${version}.suffix
debug: true
plugins:
  - - '@semantic-release/commit-analyzer'
    - preset: conventionalcommits
  - - '@semantic-release/release-notes-generator'
    - host: https://your.git.com
      preset: conventionalcommits
      presetConfig:
        issueUrlFormat: 'https://your.ticket.com/{{prefix}}{{id}}'
        issuePrefixes: ['PROJ-']
```

If you commit using the conventional format:

```bash
git commit -am "feat(api): add api"
```

And run:

```bash
pnpm dlx semantic-release
```

You’ll see a generated release note. By default, the initial release version is 1.0.0. The host option controls the link format for commits in the release notes.

Note: If you run Gitea in a Kubernetes cluster, the commit links are configured to use the service DNS by default. You can change this by configuring the host option.

Example output:

```bash
## 1.0.0 (2025-08-09)

### Features

    * **api:** add api ([f03a53f](https://your.git.com/jayground8/tutorial/commit/f03a53f2042c53513d5b89ba2a7a7f8605e3a311))
```

If you make another commit referencing a Jira ticket:

```bash
git commit -am "fix(api): fix bug PROJ-5"
```

You’ll see that the issue is linked automatically, and the version is bumped to a patch release. Because you configured issueFormat and issuePrefix, you can see the link for the reference. [The conventional-changelog-conventionalcommits](https://github.com/conventional-changelog/conventional-changelog/blob/81da80996888efb0277f7c6f76f2dd39164d81bd/packages/conventional-changelog-conventionalcommits/README.md) package provides these options:

```bash
## 1.0.1 (2025-08-09)

### Bug Fixes

    * **api:** fix bug [PROJ-5](https://your.ticket.com/PROJ-5) ([7b20f94](https://your.git.com/jayground8/tutorial/commit/7b20f9454d02ebe86790f6082355f7bc670ceed7))
```

For breaking changes, I prefer using `!:` instead of `BREAKING CHANGE:` because it’s shorter and cleaner:

```bash
git commit -am 'fix(api)!: Backward compatibility is not guaranteed'
```

This will bump the major version and add a “BREAKING CHANGES” section:

```bash
## 2.0.0 (2025-08-09)

### ⚠ BREAKING CHANGES

    * **api:** Backward compatibility is not guaranteed

### Bug Fixes

    * **api:** Backward compatibility is not guaranteed ([c8d5a51](https://your.git.com/jayground8/tutorial/commit/c8d5a51bbd6d5c1bb2ef2c30ee42c2e266571b03))
```

There are plugins for releasing to GitHub, Gitea, and others. Here’s a final .releaserc.yml example for Gitea, with @semantic-release/exec used to save the version number as a file:

`.releaserc.yml`

```yaml
branches:
  - 'main'
tagFormat: v${version}.suffix
debug: true
plugins:
  - - '@semantic-release/commit-analyzer'
    - preset: conventionalcommits
  - - '@semantic-release/release-notes-generator'
    - host: https://your.git.com
      preset: conventionalcommits
      presetConfig:
        issueUrlFormat: 'https://your.ticket.com/{{prefix}}{{id}}'
        issuePrefixes: ['PROJ-']
  - '@saithodev/semantic-release-gitea'
  - '@semantic-release/exec'
  - - '@semantic-release/exec'
    - prepareCmd: 'echo ${nextRelease.version} > next-version.txt'
```

In my case, saving custom variables to GitHub environment variables didn’t work in Gitea Actions. That’s why I wrote the version to a file and read it later to set GitHub output variables:

```bash
 echo "MY_VARIABLE=my_value" >> $GITHUB_ENV
```

`.gitea/workflows/demo.yaml`

```yaml
name: Gitea Actions Demo
run-name: testing
on:
  workflow_dispatch:
jobs:
  release:
    name: release
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Install dependencies (with pnpm)
        uses: pnpm/action-setup@v4
        with:
          version: 10.10.0
          run_install: false

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: release
        env:
          GITEA_TOKEN: ${{ secrets.API_KEY }}
          GITEA_URL: https://git.provisieducation.com
        run: pnpm dlx semantic-release

      - name: version
        id: version
        run: |
          echo "VERSION=$(cat next-version.txt)" >> ${GITHUB_OUTPUT}

      - name: Login to Docker Hub
        uses: docker/login-action@v3
        with:
          registry: ${{ vars.DOCKER_REGISTRY }}
          username: ${{ vars.DOCKER_USERNAME }}
          password: ${{ secrets.DOCKER_PASSWORD }}
      - name: Set up QEMU
        uses: docker/setup-qemu-action@v3
      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3
      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          push: true
          tags: ${{ vars.DOCKER_REGISTRY}}/jayground8/tutorial:${{ steps.version.outputs.VERSION}}
```

## lint-staged

You can also run ESLint and Prettier on the files staged for commit. This ensures that your code is linted and formatted before it’s committed.

```bash
pnpm add -D lint-staged
echo "pnpm dlx lint-staged" >> .husky/pre-commit
```

`package.json`

```json
{
  "lint-staged": {
    "*": "prettier --ignore-unknown --write"
  }
}
```

## Conclusion

I introduced several open-source tools that help ensure everyone follows the same commit message conventions and make it easy to manage versions and release notes based on those consistent messages.
