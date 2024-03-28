# VS Code: Better Git Line Blame

A simple VS Code extension that annotates the current line with git blame information.

It's like the [GitLens] line annotation feature, but faster.

## Install

Get [Better Git Line Blame](https://marketplace.visualstudio.com/items?itemName=mk12.better-git-line-blame) on the Visual Studio Marketplace.

## Features

- Displays line annotations in the same style as GitLens.
- Caches blame data so annotations are instantaneous.
- On hover, shows the commit author, date, message, and SHA.
- Includes a "Show diff" link using VS Code's built-in diff viewer.
- Annotates all lines in a selection at once (configurable).
- Supports multiple git repositories in the same workspace.
- Uses `git blame --incremental` to provide blame quickly and incrementally.
- Loads commit message lazily without blocking blame annotation rendering.
- Handles untracked files, unsaved edits, and git branch changes.
- Provides "Reblame File" and "Clear Cache" commands (rarely needed).

## Configuration

- **betterGitLineBlame.ignoreWhitespaceChanges** (default: true)
    - Ignore whitespace changes when blaming lines, i.e. pass the `-w` flag to git blame.
- **betterGitLineBlame.reblameOnSave** (default: false)
    - Run the "Reblame File" command automatically on save. The extension already adapts the blame to local edits, and reblames on git branch changes, so this is not necessary. However, reblaming more often ensures that "Uncommitted changes" is only shown on lines with a diff, not on changes that you later undid.
- **betterGitLineBlame.maxSummaryLength** (default: 50)
    - Maximum length of commit message summaries in line annotations. Summaries longer than this will be truncated with an ellipsis. Set to 0 for no limit.
- **betterGitLineBlame.maxBlamedLines** (default: 100)
    - Maximum number of selected lines to annotate. Set to 1 to only annotate a single line at a time. Set to 0 for no limit.
- **workbench.colorCustomizations** > **betterGitLineBlame.foregroundColor**
    - Foreground color of the line blame annotations.

## Alternatives

The alternative I'm competing with is [GitLens]. I find it too bloated, and dislike how it pushes paid features.

Someone else had the exact same idea with [carlthome/vscode-git-line-blame](https://github.com/carlthome/vscode-git-line-blame). However, as of March 2024, that extension is much simpler: it spawns a git process every time the text cursor moves.

## License

© 2024 Mitchell Kember

VS Code Git Line Blame is available under the MIT License; see [LICENSE](LICENSE.md) for details.

[GitLens]: https://gitlens.amod.io
