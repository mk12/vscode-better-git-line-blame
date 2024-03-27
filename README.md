# VS Code: Better Git Line Blame

A simple VS Code extension that annotates the current line with git blame information.

I created this extension because I find [GitLens] too bloated. Line blaming is the only feature that I actually need.

## Install

Get [Better Git Line Blame](https://marketplace.visualstudio.com/items?itemName=mk12.better-git-line-blame) on the Studio Marketplace

## Features

- Displays line annotations in the same style as GitLens.
- Annotates all lines at once when selecting multiple lines.
- On hover, shows the commit author, date, message, and SHA.
- Includes a "Show diff" link using VS Code's built-in diff viewer.
- Supports multiple git repositories in the same workspace.
- Uses `git blame --incremental` to provide blame quickly and incrementally.
- Loads commit message lazily without blocking blame annotation rendering.
- Caches all information to avoid invoking git more than necessary.
- Handles untracked files, unsaved edits, and git branch changes.
- Provides "Reblame File" and "Clear Cache" commands (rarely needed).

## Alternatives

The alternative I'm competing with is [GitLens]. I find it too bloated, and dislike how it pushes paid features.

Someone else had the exact same idea with [carlthome/vscode-git-line-blame](https://github.com/carlthome/vscode-git-line-blame). However, as of March 2024, that extension is much simpler: it spawns a git process every time the cursor moves.

## License

© 2024 Mitchell Kember

VS Code Git Line Blame is available under the MIT License; see [LICENSE](LICENSE.md) for details.

[GitLens]: https://gitlens.amod.io
