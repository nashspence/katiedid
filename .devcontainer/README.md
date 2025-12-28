# Dev Container (Docker-in-Docker + Open Codex CLI)

This dev container uses the multi-language **universal** base image and layers Docker-in-Docker, the Open Codex CLI, GitHub CLI, and helpful VS Code extensions (Docker, Python, GitHub, Copilot, and OpenAI Codex).

Credential handling is designed to keep secrets out of the environment and repository by default. The container will reuse a forwarded SSH agent **if** you share one, but if no agent is forwarded it will start its own `ssh-agent` socket under `/home/vscode/.ssh/ssh-agent.sock` and export it for your shell. Both `gh` and `open-codex` store tokens in their own secure keychains after interactive login.

## Prerequisites
- Install Docker and VS Code with the Dev Containers extension on the host.
- If you prefer to forward a host SSH agent, start it locally and add your key: `eval "$(ssh-agent -s)"` then `ssh-add ~/.ssh/<key>`. The agent socket will be reused automatically when present.
- If you do **not** forward an agent, the container will start its own `ssh-agent`. Use `ssh-keygen -t ed25519 -C "<email>"` (or `gh auth ssh-keygen` if prompted during login) to create a key, then `ssh-add ~/.ssh/id_ed25519` to load it into the container agent. Run `gh auth login --web --git-protocol ssh` to upload the public key to GitHub and store your token in the GitHub CLI keyring instead of environment variables.
- Authenticate OpenAI with `open-codex auth login` (supports browser/device-based login). The CLI stores tokens in its keyring-backed config directory instead of environment variables.

## Usage
1. Open the repository in VS Code and choose **Reopen in Container**.
2. Verify tooling: `open-codex --version`, `gh --version`, and `ssh -T git@github.com` (this reports which agent/socket is in use and confirms connectivity) in the integrated terminal.
3. Create and switch to a branch: `git switch -c <branch-name>`.
4. Authenticate Open Codex: `open-codex auth login` (uses secure keychain storage).
5. Use the CLI to update code, for example: `open-codex apply --prompt "describe the change"`.
6. Stage and commit: `git add .` then `git commit -m "<message>"`.
7. Push and open a PR with GitHub CLI: `git push -u origin <branch-name>` then `gh pr create`.

Credentials stay outside the container image and repo; VS Code and the CLIs rely on forwarded SSH agent sockets and their own secure keychains.
